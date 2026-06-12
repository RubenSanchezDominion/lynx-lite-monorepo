import type { WriteApi } from '@influxdata/influxdb-client';
import { getPeriod, parseDatadisLocal, type Tariff } from './periods.js';
import { writePoints, type MeasurementPoint } from './points.js';

// ─── Formas de respuesta DATADIS (subconjunto usado) ──────────────────────────

export interface ConsumptionRecord {
  cups: string;
  date: string; // 'YYYY/MM/DD' (hora local España)
  time: string; // 'HH:MM'
  consumptionKWh: number;
  obtainMethod: 'Real' | 'Estimada';
  surplusEnergyKWh: number;
}

export interface MaxPowerRecord {
  cups: string;
  date: string;
  time: string;
  maxPower: number; // Vatios (W)
  period: string;   // '1'..'6'
}

export interface ReactiveRecord {
  cups: string;
  date: string;    // 'YYYY/MM' o 'YYYY/MM/DD' (inicio de mes)
  period: string;  // '1'..'6'
  kvarh: number;
}

// ─── Transformaciones puras (record → MeasurementPoint) ────────────────────────

// hourly_consumption. obtainMethod 'Estimada' marca estimated=true y gap=true (SPECS §1.5/§3.3).
export function consumptionToPoint(rec: ConsumptionRecord, tariff: Tariff): MeasurementPoint {
  const { utc, hour, day } = parseDatadisLocal(rec.date, rec.time);
  const period = getPeriod(day, hour, tariff);
  const estimated = rec.obtainMethod === 'Estimada';

  return {
    measurement: 'hourly_consumption',
    tags: {
      cups: rec.cups,
      period,
      estimated: estimated ? 'true' : 'false',
      gap: estimated ? 'true' : 'false',
    },
    fields: {
      kwh: rec.consumptionKWh,
      surplus_kwh: rec.surplusEnergyKWh ?? 0,
    },
    timestamp: utc,
  };
}

// max_power. maxPower viene en W → dividir por 1000 (SPECS §3.3 / TC-PRE-008).
export function maxPowerToPoint(rec: MaxPowerRecord): MeasurementPoint {
  const { utc } = parseDatadisLocal(rec.date, rec.time);
  return {
    measurement: 'max_power',
    tags: { cups: rec.cups, period: `P${rec.period}` },
    fields: { kw: rec.maxPower / 1000 },
    timestamp: utc,
  };
}

// monthly_reactive. Timestamp al inicio del mes (UTC).
export function reactiveToPoint(rec: ReactiveRecord): MeasurementPoint {
  const parts = rec.date.split('/').map(Number);
  const [y, m] = parts;
  const utc = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  return {
    measurement: 'monthly_reactive',
    tags: { cups: rec.cups, period: `P${rec.period}` },
    fields: { kvarh: rec.kvarh },
    timestamp: utc,
  };
}

// ─── HTTP client mínimo (inyectable para test) ─────────────────────────────────

export interface DatadisHttp {
  // Devuelve el array JSON del endpoint o lanza si status !== 2xx.
  get(path: string, query: Record<string, string>): Promise<unknown>;
}

// Error tipado para propagar 429 sin reintentos (SPECS §1.5, TC-PRE-016).
export class DatadisRateLimitError extends Error {
  constructor() {
    super('DATADIS 429 — consulta repetida en < 24h');
    this.name = 'DatadisRateLimitError';
  }
}

// Resuelve el distributorCode de un CUPS vía get-supplies (DATADIS no lo expone
// en otros endpoints). Devuelve null si el CUPS no aparece.
export async function fetchDistributorCode(http: DatadisHttp, cups: string): Promise<string | null> {
  const raw = (await http.get('/api-private/api/get-supplies', {})) as Array<{
    cups: string;
    distributorCode: string;
  }>;
  const match = raw.find(s => s.cups === cups);
  return match?.distributorCode ?? null;
}

// ─── Orquestación: fetch + transform + write ───────────────────────────────────

export async function fetchConsumption(
  http: DatadisHttp,
  params: { cups: string; distributorCode: string; startDate: string; endDate: string; tariff: Tariff; measurementType?: string; pointType?: string },
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const raw = (await http.get('/api-private/api/get-consumption-data', {
    cups: params.cups,
    distributorCode: params.distributorCode,
    startDate: params.startDate,
    endDate: params.endDate,
    measurementType: params.measurementType ?? '0',
    pointType: params.pointType ?? '5',
  })) as ConsumptionRecord[];

  const points = raw.map(r => consumptionToPoint(r, params.tariff));
  writePoints(writeApi, points);
  return points;
}

export async function fetchMaxPower(
  http: DatadisHttp,
  params: { cups: string; distributorCode: string; startDate: string; endDate: string },
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const raw = (await http.get('/api-private/api/get-max-power', {
    cups: params.cups,
    distributorCode: params.distributorCode,
    startDate: params.startDate,
    endDate: params.endDate,
  })) as MaxPowerRecord[];

  const points = raw.map(maxPowerToPoint);
  writePoints(writeApi, points);
  return points;
}

// Reactiva: solo 3.0TD. Array vacío → no se escribe nada (SPECS §1.5 / TC-PRE-021).
export async function fetchReactive(
  http: DatadisHttp,
  params: { cups: string; distributorCode: string; startDate: string; endDate: string },
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const raw = (await http.get('/api-private/api/get-reactive-data-v2', {
    cups: params.cups,
    distributorCode: params.distributorCode,
    startDate: params.startDate,
    endDate: params.endDate,
  })) as ReactiveRecord[];

  if (!Array.isArray(raw) || raw.length === 0) return [];

  const points = raw.map(reactiveToPoint);
  writePoints(writeApi, points);
  return points;
}
