import type { QueryApi } from '@influxdata/influxdb-client';
import type { Tariff } from '@lynx-lite/data-collector';
import {
  aggregateConsumptionAndPvpc,
  type HourlyConsumptionRow,
  type HourlyPriceRow,
} from './pvpcWeighting.js';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Datos de series temporales necesarios para calcular una pre-factura.
export interface PreInvoiceTimeSeries {
  // kWh facturables por período (solo puntos con gap=false). {} si no hay datos.
  consumptionByPeriod: Record<string, number>;
  // kW máximo por período (max_power). {} si ICP / sin datos.
  maxPowerByPeriod: Record<string, number>;
  // €/kWh medio ponderado por consumo, por período.
  pvpcByPeriod: Record<string, number>;
  // Horas con gap=true por período (estimadas o imputadas).
  gapHoursByPeriod: Record<string, number>;
  // Total de horas con gap en el período.
  totalGapHours: number;
  // ¿Hay al menos un punto facturable (gap=false) en el período?
  hasBillableData: boolean;
}

// Interfaz inyectable: los resolvers la usan; los tests la mockean.
export interface PreInvoiceDataSource {
  load(cups: string, from: Date, to: Date, tariff: Tariff): Promise<PreInvoiceTimeSeries>;
  loadReactiveByPeriod(cups: string, from: Date, to: Date): Promise<Record<string, number> | null>;
}

// ─── Implementación Flux contra InfluxDB ───────────────────────────────────────
export function makeInfluxDataSource(queryApi: QueryApi): PreInvoiceDataSource {
  return {
    async load(cups, from, to, _tariff): Promise<PreInvoiceTimeSeries> {
      const range = `range(start: ${from.toISOString()}, stop: ${to.toISOString()})`;

      // Consumo facturable horario (gap=false) — sin agregar: necesario para ponderar PVPC.
      const consumptionFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh" and r.gap == "false")
          |> keep(columns: ["_time", "_value", "period"])
      `;
      // Horas con gap=true por período.
      const gapFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh" and r.gap == "true")
          |> group(columns: ["period"])
          |> count()
      `;
      // Maxímetro por período.
      const maxPowerFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "max_power" and r.cups == "${cups}" and r._field == "kw")
          |> group(columns: ["period"])
          |> max()
      `;
      // Precio PVPC horario (sin agregar) — se pondera por consumo en JS.
      const pvpcFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "pvpc_price" and r._field == "eur_kwh")
          |> keep(columns: ["_time", "_value"])
      `;

      const [consRows, gaps, maxp, priceRows] = await Promise.all([
        queryApi.collectRows<{ _time: string; _value: number; period: string }>(consumptionFlux),
        queryApi.collectRows<{ period: string; _value: number }>(gapFlux),
        queryApi.collectRows<{ period: string; _value: number }>(maxPowerFlux),
        queryApi.collectRows<{ _time: string; _value: number }>(pvpcFlux),
      ]);

      const consumption: HourlyConsumptionRow[] = consRows.map(r => ({ period: r.period, time: r._time, kwh: r._value }));
      const prices: HourlyPriceRow[] = priceRows.map(r => ({ time: r._time, eurKwh: r._value }));

      // Suma por período + PVPC ponderado (función pura, testeada).
      const { consumptionByPeriod, pvpcByPeriod } = aggregateConsumptionAndPvpc(consumption, prices);

      const gapHoursByPeriod: Record<string, number> = {};
      let totalGapHours = 0;
      for (const r of gaps) {
        gapHoursByPeriod[r.period] = r._value;
        totalGapHours += r._value;
      }

      const maxPowerByPeriod: Record<string, number> = {};
      for (const r of maxp) maxPowerByPeriod[r.period] = r._value;

      return {
        consumptionByPeriod,
        maxPowerByPeriod,
        pvpcByPeriod,
        gapHoursByPeriod,
        totalGapHours,
        hasBillableData: consRows.length > 0,
      };
    },

    async loadReactiveByPeriod(cups, from, to): Promise<Record<string, number> | null> {
      const flux = `
        from(bucket: "${bucket}")
          |> range(start: ${from.toISOString()}, stop: ${to.toISOString()})
          |> filter(fn: (r) => r._measurement == "monthly_reactive" and r.cups == "${cups}" and r._field == "kvarh")
          |> group(columns: ["period"])
          |> sum()
      `;
      const rows = await queryApi.collectRows<{ period: string; _value: number }>(flux);
      if (rows.length === 0) return null;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.period] = r._value;
      return out;
    },
  };
}
