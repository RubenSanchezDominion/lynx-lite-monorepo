import type { QueryApi } from '@influxdata/influxdb-client';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// ¿Existe al menos un punto de hourly_consumption para este CUPS en el día dado?
// Usado por el job diario para no repetir llamadas a DATADIS (anti-429, TC-PRE-026).
export function makeConsumptionExists(queryApi: QueryApi) {
  return async (cups: string, dateUtc: Date): Promise<boolean> => {
    const dayStart = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${dayStart.toISOString()}, stop: ${dayEnd.toISOString()})
        |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}")
        |> limit(n: 1)
    `;

    const rows = await queryApi.collectRows(flux);
    return rows.length > 0;
  };
}
