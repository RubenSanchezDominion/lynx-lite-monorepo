import type { QueryApi } from '@influxdata/influxdb-client';
import type { Tariff } from '@lynx-lite/data-collector';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Bucket horario crudo de consumo + precio de mercado (PVPC). La COMPOSICIÓN del €/kWh
// (PVPC + peaje + cargo de energía) la hace el servicio reutilizando los maestros de M01, de modo
// que este data source no conoce tarifas (igual que alertData no calcula nada de negocio).
export interface RawConsumptionHour {
  ts: string; // ISO UTC, inicio del bucket
  hours: number; // duración en horas (1 | 0.25)
  kwh: number;
  pvpcEurKwh: number; // precio horario PVPC (€/kWh); 0 si no hay precio para esa hora
  gap: boolean;
}

export interface KpiDataSource {
  // Curva de consumo + PVPC sobre [from, to) (cubre el rango del fichero de producción).
  load(cups: string, from: Date, to: Date, tariff: Tariff): Promise<RawConsumptionHour[]>;
}

// Detecta la resolución (1 h u 0.25 h) a partir del menor salto entre timestamps.
export function detectIntervalHours(times: number[]): number {
  if (times.length < 2) return 1;
  const sorted = [...times].sort((a, b) => a - b);
  let minDelta = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  return minDelta <= 30 * 60_000 ? 0.25 : 1;
}

// ─── Implementación Flux contra InfluxDB ───────────────────────────────────────
export function makeInfluxKpiDataSource(queryApi: QueryApi): KpiDataSource {
  return {
    async load(cups, from, to, _tariff): Promise<RawConsumptionHour[]> {
      const range = `range(start: ${from.toISOString()}, stop: ${to.toISOString()})`;

      // Consumo facturable horario (gap=false) + horas con gap (para marcar calidad).
      const consumptionFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh")
          |> keep(columns: ["_time", "_value", "gap"])
      `;
      // Precio PVPC horario.
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

      const hours = detectIntervalHours(consRows.map(r => new Date(r._time).getTime()));

      return consRows.map(r => ({
        ts: r._time,
        hours,
        kwh: r._value,
        pvpcEurKwh: priceAt.get(r._time) ?? 0,
        gap: r.gap === 'true',
      }));
    },
  };
}
