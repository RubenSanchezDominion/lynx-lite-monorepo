import type { WriteApi } from '@influxdata/influxdb-client';
import { writePoints, type MeasurementPoint } from './points.js';

// ─── Formas de respuesta REData (estructura-generacion, formato JSONAPI) ────────

export interface RedataValue {
  value: string; // MW (REData los devuelve como texto)
  percentage: number | null;
  datetime: string; // ISO 8601 con offset
}

export interface RedataSeries {
  attributes: { title: string; values: RedataValue[] };
}

export interface RedataResponse {
  included: RedataSeries[];
}

// ─── Representación intermedia: una hora del mix con los MW por tecnología ──────

export interface GenerationMixHour {
  datetime: string; // ISO 8601 (de REData)
  mwByTech: Record<string, number>; // título de tecnología → MW
}

// ─── Transformaciones puras ─────────────────────────────────────────────────────

// Pivota la respuesta JSONAPI (una serie por tecnología) a horas con MW por tecnología.
export function parseGenerationMix(raw: RedataResponse): GenerationMixHour[] {
  const byDatetime = new Map<string, Record<string, number>>();
  for (const serie of raw?.included ?? []) {
    const title = serie.attributes?.title;
    if (!title) continue;
    for (const v of serie.attributes.values ?? []) {
      const mw = byDatetime.get(v.datetime) ?? {};
      mw[title] = Number(v.value);
      byDatetime.set(v.datetime, mw);
    }
  }
  return [...byDatetime.entries()].map(([datetime, mwByTech]) => ({ datetime, mwByTech }));
}

// Factor de emisión de una hora: media de los coeficientes ponderada por generación
// (Σ MW·coef / Σ MW), en gCO₂/kWh. Una tecnología sin coeficiente conocido aporta 0.
export function composeCo2Factor(hour: GenerationMixHour, coeffs: Record<string, number>): number {
  let totalMw = 0;
  let weighted = 0;
  for (const [tech, mw] of Object.entries(hour.mwByTech)) {
    if (!(mw > 0)) continue;
    totalMw += mw;
    weighted += mw * (coeffs[tech] ?? 0);
  }
  return totalMw > 0 ? weighted / totalMw : 0;
}

// Punto InfluxDB `co2_factor` (tag system, field g_per_kwh) a partir de una hora del mix.
export function genMixToCo2Point(
  hour: GenerationMixHour,
  coeffs: Record<string, number>,
  system = 'peninsula',
): MeasurementPoint {
  return {
    measurement: 'co2_factor',
    tags: { system },
    fields: { g_per_kwh: composeCo2Factor(hour, coeffs) },
    timestamp: new Date(hour.datetime),
  };
}

// ─── HTTP client mínimo (inyectable) ───────────────────────────────────────────

export interface RedataHttp {
  get(path: string, query: Record<string, string>): Promise<unknown>;
}

// Pide el mix horario a REData, compone el factor de emisión y lo escribe en `co2_factor`.
export async function fetchGenerationMix(
  http: RedataHttp,
  params: { startDate: string; endDate: string }, // "YYYY-MM-DDTHH:mm"
  coeffs: Record<string, number>,
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const raw = (await http.get('/es/datos/generacion/estructura-generacion', {
    start_date: params.startDate,
    end_date: params.endDate,
    time_trunc: 'hour',
  })) as RedataResponse;

  const points = parseGenerationMix(raw).map(h => genMixToCo2Point(h, coeffs));
  writePoints(writeApi, points);
  return points;
}
