import type { QueryApi } from '@influxdata/influxdb-client';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Hora cruda: consumo facturable + factor de emisión horario ya compuesto (gCO₂/kWh), unidos por _time.
// `factorGPerKwh` es null si no hay factor para esa hora (el servicio decide CO2_NO_FACTOR_DATA si
// faltan todos). El measurement `co2_factor` lo escribe la ingesta on-demand (carbonIngestion).
export interface RawCarbonHour {
  ts: string; // ISO UTC
  kwh: number;
  gap: boolean;
  factorGPerKwh: number | null;
}

export interface CarbonDataSource {
  // Curva de consumo + factor de emisión sobre [from, to).
  load(cups: string, from: Date, to: Date): Promise<RawCarbonHour[]>;
}

// ─── Implementación Flux contra InfluxDB ───────────────────────────────────────
export function makeInfluxCarbonDataSource(queryApi: QueryApi): CarbonDataSource {
  return {
    async load(cups, from, to): Promise<RawCarbonHour[]> {
      const range = `range(start: ${from.toISOString()}, stop: ${to.toISOString()})`;

      const consumptionFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh")
          |> keep(columns: ["_time", "_value", "gap"])
      `;
      const factorFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "co2_factor" and r._field == "g_per_kwh")
          |> keep(columns: ["_time", "_value"])
      `;

      const [consRows, factorRows] = await Promise.all([
        queryApi.collectRows<{ _time: string; _value: number; gap?: string }>(consumptionFlux),
        queryApi.collectRows<{ _time: string; _value: number }>(factorFlux),
      ]);

      const factorAt = new Map<string, number>();
      for (const f of factorRows) factorAt.set(f._time, f._value);

      return consRows.map(r => ({
        ts: r._time,
        kwh: r._value,
        gap: r.gap === 'true',
        factorGPerKwh: factorAt.has(r._time) ? (factorAt.get(r._time) as number) : null,
      }));
    },
  };
}
