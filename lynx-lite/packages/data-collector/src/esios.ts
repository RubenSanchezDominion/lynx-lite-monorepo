import type { WriteApi } from '@influxdata/influxdb-client';
import { periodForUtc, type Tariff } from './periods.js';
import { writePoints, type MeasurementPoint } from './points.js';

// ─── Formas de respuesta ESIOS (indicador 1001) ───────────────────────────────

export interface EsiosValue {
  value: number;         // €/MWh
  datetime_utc?: string; // ISO 8601 UTC
  datetime?: string;     // ISO 8601 con offset
}

export interface EsiosResponse {
  indicator: { values: EsiosValue[] };
}

// ─── Transformación pura ───────────────────────────────────────────────────────

// pvpc_price. value €/MWh → €/kWh (÷1000). Período asignado por hora Madrid (SPECS §3.3 / TC-PRE-008).
export function pvpcToPoint(val: EsiosValue, tariff: Tariff): MeasurementPoint {
  const utc = new Date(val.datetime_utc ?? val.datetime ?? '');
  return {
    measurement: 'pvpc_price',
    tags: { period: periodForUtc(utc, tariff) },
    fields: { eur_kwh: val.value / 1000 },
    timestamp: utc,
  };
}

// ─── HTTP client mínimo (inyectable) ───────────────────────────────────────────

export interface EsiosHttp {
  get(path: string, query: Record<string, string>): Promise<unknown>;
}

export async function fetchPvpcPrices(
  http: EsiosHttp,
  params: { startDate: string; endDate: string; tariff: Tariff },
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const raw = (await http.get('/indicators/1001', {
    start_date: params.startDate,
    end_date: params.endDate,
    time_trunc: 'hour',
  })) as EsiosResponse;

  const values = raw?.indicator?.values ?? [];
  const points = values.map(v => pvpcToPoint(v, params.tariff));
  writePoints(writeApi, points);
  return points;
}
