import type { QueryApi } from '@influxdata/influxdb-client';
import { fetchPvProduction, type PvgisHttp, type PvProduction } from '@lynx-lite/data-collector';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Hora cruda de consumo + PVPC (energía). La composición del €/kWh y el reparto de la producción la
// hace el servicio; este data source solo trae curva + precio (InfluxDB) y producción (PVGIS).
export interface RawSolarHour {
  ts: string; // ISO UTC
  kwh: number;
  pvpcEurKwh: number; // precio horario PVPC (€/kWh); 0 si no hay precio para esa hora
  gap: boolean;
}

export interface SolarProductionParams {
  lat: number;
  lon: number;
  kwp: number;
  lossPct: number;
  tilt: number;
  azimuth: number;
}

export interface SolarDataSource {
  // Curva de consumo + PVPC sobre [from, to).
  loadConsumption(cups: string, from: Date, to: Date): Promise<RawSolarHour[]>;
  // Producción mensual/anual de PVGIS (lanza si PVGIS no responde).
  fetchProduction(params: SolarProductionParams): Promise<PvProduction>;
}

// ─── Implementación real: InfluxDB (consumo + PVPC) + PVGIS (producción) ────────
export function makeInfluxSolarDataSource(queryApi: QueryApi, pvgis: PvgisHttp): SolarDataSource {
  return {
    async loadConsumption(cups, from, to): Promise<RawSolarHour[]> {
      const range = `range(start: ${from.toISOString()}, stop: ${to.toISOString()})`;

      const consumptionFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh")
          |> keep(columns: ["_time", "_value", "gap"])
      `;
      const pvpcFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "pvpc_price" and r._field == "eur_kwh")
          |> keep(columns: ["_time", "_value"])
      `;

      const [consRows, priceRows] = await Promise.all([
        queryApi.collectRows<{ _time: string; _value: number; gap?: string }>(consumptionFlux),
        queryApi.collectRows<{ _time: string; _value: number }>(pvpcFlux),
      ]);

      const priceAt = new Map<string, number>();
      for (const p of priceRows) priceAt.set(p._time, p._value);

      return consRows.map(r => ({
        ts: r._time,
        kwh: r._value,
        pvpcEurKwh: priceAt.get(r._time) ?? 0,
        gap: r.gap === 'true',
      }));
    },

    async fetchProduction(params): Promise<PvProduction> {
      return fetchPvProduction(pvgis, params);
    },
  };
}
