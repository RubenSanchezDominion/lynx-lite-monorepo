import type { QueryApi } from '@influxdata/influxdb-client';
import { madridHourAndDay, periodForUtc, type Tariff } from '@lynx-lite/data-collector';
import type { AlertInterval } from '@lynx-lite/alerts-engine';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Nº de semanas de referencia para el z-score (SPECS §5.0 punto 1 / §5.1).
export const REFERENCE_WEEKS = 13;

// Agregados que necesita el alerts-engine (SPECS §5.4). Los construye el data source a partir de
// `hourly_consumption`: el día evaluado + las 13 semanas previas (referencia por slot).
export interface AlertSeries {
  targetDay: AlertInterval[]; // intervalos del día evaluado (incluye estimados/gap)
  referenceBySlot: Record<string, number[]>; // "DOW-HH" → kWh facturables (gap=false) de la referencia
  intervalHours: number; // 1 | 0.25
  referenceWeeks: number; // nº de semanas distintas con datos en la referencia (histórico mínimo)
  hasUsableData: boolean; // ¿hay ≥1 intervalo gap=false el día evaluado?
}

export interface AlertDataSource {
  // `day` es la medianoche UTC del día a evaluar (por defecto D-2; lo decide el servicio).
  load(cups: string, day: Date, tariff: Tariff): Promise<AlertSeries>;
}

// Punto crudo de la curva (igual forma para InfluxDB y demo).
export interface RawPoint {
  time: string; // ISO UTC
  kwh: number;
  estimated: boolean;
  gap: boolean;
}

function detectIntervalHours(points: RawPoint[]): number {
  if (points.length < 2) return 1;
  const times = points.map(p => new Date(p.time).getTime()).sort((a, b) => a - b);
  let minDelta = Infinity;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  return minDelta <= 30 * 60_000 ? 0.25 : 1;
}

// Construye los agregados a partir de la curva cruda del día + la referencia. Función pura:
// la comparten la implementación InfluxDB y el modo demo, y es directamente testeable.
export function buildAlertSeries(
  target: RawPoint[],
  reference: RawPoint[],
  tariff: Tariff,
): AlertSeries {
  const intervalHours = detectIntervalHours([...target, ...reference]);

  const targetDay: AlertInterval[] = target.map(p => {
    const d = new Date(p.time);
    const { hour, day } = madridHourAndDay(d);
    const period = parseInt(periodForUtc(d, tariff).slice(1), 10);
    return {
      ts: p.time,
      localHour: hour,
      weekday: day,
      period,
      kwh: p.kwh,
      estimated: p.estimated,
      gap: p.gap,
    };
  });

  // Referencia por slot semanal-horario: solo puntos facturables (gap=false).
  const referenceBySlot: Record<string, number[]> = {};
  const weekBuckets = new Set<number>();
  for (const p of reference) {
    if (p.gap) continue;
    const d = new Date(p.time);
    const { hour, day } = madridHourAndDay(d);
    (referenceBySlot[`${day}-${hour}`] ??= []).push(p.kwh);
    weekBuckets.add(Math.floor(d.getTime() / WEEK_MS));
  }

  return {
    targetDay,
    referenceBySlot,
    intervalHours,
    referenceWeeks: weekBuckets.size,
    hasUsableData: targetDay.some(iv => !iv.gap),
  };
}

// ─── Implementación Flux contra InfluxDB ───────────────────────────────────────
export function makeInfluxAlertDataSource(queryApi: QueryApi): AlertDataSource {
  return {
    async load(cups, day, tariff): Promise<AlertSeries> {
      const dayEnd = new Date(day.getTime() + DAY_MS);
      const refStart = new Date(day.getTime() - REFERENCE_WEEKS * WEEK_MS);

      // Día evaluado: TODOS los puntos (sin filtrar gap, para poder detectar ESTIMATED).
      const targetFlux = `
        from(bucket: "${bucket}")
          |> range(start: ${day.toISOString()}, stop: ${dayEnd.toISOString()})
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh")
          |> keep(columns: ["_time", "_value", "estimated", "gap"])
      `;
      // Referencia: solo curva facturable (gap=false).
      const refFlux = `
        from(bucket: "${bucket}")
          |> range(start: ${refStart.toISOString()}, stop: ${day.toISOString()})
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh" and r.gap == "false")
          |> keep(columns: ["_time", "_value", "gap"])
      `;

      type Row = { _time: string; _value: number; estimated?: string; gap?: string };
      const [targetRows, refRows] = await Promise.all([
        queryApi.collectRows<Row>(targetFlux),
        queryApi.collectRows<Row>(refFlux),
      ]);

      const toRaw = (r: Row): RawPoint => ({
        time: r._time,
        kwh: r._value,
        estimated: r.estimated === 'true',
        gap: r.gap === 'true',
      });

      return buildAlertSeries(targetRows.map(toRaw), refRows.map(toRaw), tariff);
    },
  };
}
