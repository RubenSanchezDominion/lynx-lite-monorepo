import type { WriteApi, QueryApi } from '@influxdata/influxdb-client';
import { periodForUtc, type Tariff } from './periods.js';
import { writePoints, type MeasurementPoint } from './points.js';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

// Busca el valor de consumo (kWh) del mismo slot horario de la semana anterior.
// Devuelve null si no hay dato disponible para ese instante.
export type PreviousWeekLookup = (utc: Date) => Promise<number | null>;

export interface ImputeParams {
  cups: string;
  tariff: Tariff;
  from: Date;             // inicio inclusivo (alineado a hora, UTC)
  to: Date;               // fin exclusivo (UTC)
  present: Set<string>;   // ISO 8601 (UTC) de las horas que DATADIS sí devolvió
  lookupPreviousWeek: PreviousWeekLookup;
}

// Imputación por perfil (SPECS §1.5): para cada hora ausente, usa el valor del
// mismo slot 7 días antes. El punto se marca gap="true", estimated="false"
// (no es estimado por DATADIS, lo imputamos nosotros). Si no hay valor previo,
// no se imputa (queda como hueco real sin dato).
//
// IMPORTANTE: los puntos imputados NO se usan en facturación (el cálculo filtra
// gap="false"); solo sirven para visualización.
export async function buildImputationPoints(p: ImputeParams): Promise<MeasurementPoint[]> {
  const points: MeasurementPoint[] = [];

  for (let t = p.from.getTime(); t < p.to.getTime(); t += HOUR_MS) {
    const iso = new Date(t).toISOString();
    if (p.present.has(iso)) continue; // hora presente: nada que imputar

    const prev = await p.lookupPreviousWeek(new Date(t - WEEK_MS));
    if (prev === null) continue; // sin referencia: no se puede imputar

    const utc = new Date(t);
    points.push({
      measurement: 'hourly_consumption',
      tags: {
        cups: p.cups,
        period: periodForUtc(utc, p.tariff),
        estimated: 'false',
        gap: 'true',
      },
      fields: { kwh: prev, surplus_kwh: 0 },
      timestamp: utc,
    });
  }

  return points;
}

// Imputa y escribe en InfluxDB. Devuelve los puntos imputados.
export async function imputeConsumptionGaps(
  params: ImputeParams,
  writeApi: WriteApi,
): Promise<MeasurementPoint[]> {
  const points = await buildImputationPoints(params);
  writePoints(writeApi, points);
  return points;
}

// Lookup real contra InfluxDB: kWh facturable (gap="false") del CUPS en el instante
// exacto `utc`. Usado como referencia "mismo slot 7 días antes". null si no existe.
export function makePreviousWeekLookup(
  queryApi: QueryApi,
  bucket: string,
  cups: string,
): PreviousWeekLookup {
  return async (utc: Date): Promise<number | null> => {
    const stop = new Date(utc.getTime() + HOUR_MS);
    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${utc.toISOString()}, stop: ${stop.toISOString()})
        |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh" and r.gap == "false")
        |> limit(n: 1)
    `;
    const rows = await queryApi.collectRows<{ _value: number }>(flux);
    return rows.length > 0 ? rows[0]._value : null;
  };
}
