import type { QueryApi } from '@influxdata/influxdb-client';
import type { Tariff } from '@lynx-lite/data-collector';
import { percentile } from '@lynx-lite/optimization-engine';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Agregados de la curva de carga que necesita el optimization-engine (SPECS §4.4).
// Los construye el data source a partir de `hourly_consumption` y `max_power`.
export interface PowerOptimizationSeries {
  granularity: 'hourly' | 'quarter';
  // Potencia derivada (kW) por power period — muestra completa de la ventana.
  powerSamplesByPeriod: Record<string, number[]>;
  // Percentil 99 mensual por período (diagnóstico de sobredimensionamiento). Clave "YYYY-MM".
  monthlyP99ByPeriod: Record<string, Record<string, number>>;
  // Máximo mensual real (max_power) por período (Pdp del exceso). Clave "YYYY-MM".
  monthlyMaxByPeriod: Record<string, Record<string, number>>;
  // Fracción (0..1) de intervalos del mes con potencia derivada > contratada, por período.
  overContractedRatioByPeriod: Record<string, Record<string, number>>;
  // Días de facturación de cada mes de la ventana (n de la fórmula de excesos). Clave "YYYY-MM".
  daysByMonth: Record<string, number>;
  // Nº de meses distintos con datos facturables (validación de histórico mínimo).
  monthsWithData: number;
  // Nº total de puntos de potencia usados en el percentil.
  sampleCount: number;
  // ¿Hay al menos un punto utilizable (gap=false)?
  hasUsableData: boolean;
}

export interface PowerOptimizationDataSource {
  load(
    cups: string,
    from: Date,
    to: Date,
    tariff: Tariff,
    contractedPower: Record<string, number>,
  ): Promise<PowerOptimizationSeries>;
}

// Mapeo período de energía → período de potencia. En 2.0TD la curva tiene 3 períodos de
// energía (P1 punta, P2 llano, P3 valle) pero solo 2 de potencia: P1 = punta+llano, P2 = valle.
// En 3.0TD coinciden (identidad).
export function powerPeriodOf(energyPeriod: string, tariff: Tariff): string {
  if (tariff === 'T_2_0TD') return energyPeriod === 'P3' ? 'P2' : 'P1';
  return energyPeriod;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Punto de curva ya derivado a potencia y etiquetado con su power period y mes.
export interface CurvePoint {
  time: string; // ISO
  kwh: number;
  energyPeriod: string;
}

// Construye los agregados a partir de la curva cruda + los máximos mensuales. Función pura:
// la usan la implementación Influx y el modo demo, y es directamente testeable.
export function buildSeries(
  curve: CurvePoint[],
  maxPowerRows: { time: string; kw: number; period: string }[],
  from: Date,
  to: Date,
  tariff: Tariff,
  contractedPower: Record<string, number>,
): PowerOptimizationSeries {
  // Granularidad: menor delta entre instantes consecutivos. ≤ 30 min ⇒ cuarto-horaria.
  const granularity = detectGranularity(curve);
  const intervalHours = granularity === 'quarter' ? 0.25 : 1;

  const powerSamplesByPeriod: Record<string, number[]> = {};
  // Muestras por mes y período (para p99 mensual y ratio de exceso).
  const monthlySamples: Record<string, Record<string, number[]>> = {};
  const monthlyOver: Record<string, Record<string, number>> = {};
  const monthlyTotal: Record<string, Record<string, number>> = {};
  const monthsSeen = new Set<string>();

  for (const pt of curve) {
    const pp = powerPeriodOf(pt.energyPeriod, tariff);
    const kw = pt.kwh / intervalHours;
    const m = monthKey(new Date(pt.time));
    monthsSeen.add(m);

    (powerSamplesByPeriod[pp] ??= []).push(kw);
    ((monthlySamples[m] ??= {})[pp] ??= []).push(kw);

    monthlyTotal[m] ??= {};
    monthlyTotal[m][pp] = (monthlyTotal[m][pp] ?? 0) + 1;
    monthlyOver[m] ??= {};
    if (kw > (contractedPower[pp] ?? Infinity)) {
      monthlyOver[m][pp] = (monthlyOver[m][pp] ?? 0) + 1;
    }
  }

  // p99 mensual por período.
  const monthlyP99ByPeriod: Record<string, Record<string, number>> = {};
  for (const m of Object.keys(monthlySamples)) {
    monthlyP99ByPeriod[m] = {};
    for (const pp of Object.keys(monthlySamples[m])) {
      monthlyP99ByPeriod[m][pp] = percentile(monthlySamples[m][pp], 99);
    }
  }

  // Ratio de intervalos en exceso por mes y período.
  const overContractedRatioByPeriod: Record<string, Record<string, number>> = {};
  for (const m of Object.keys(monthlyTotal)) {
    overContractedRatioByPeriod[m] = {};
    for (const pp of Object.keys(monthlyTotal[m])) {
      const total = monthlyTotal[m][pp];
      const over = monthlyOver[m]?.[pp] ?? 0;
      overContractedRatioByPeriod[m][pp] = total > 0 ? over / total : 0;
    }
  }

  // Máximo mensual por período (Pdp) a partir de max_power.
  const monthlyMaxByPeriod: Record<string, Record<string, number>> = {};
  for (const r of maxPowerRows) {
    const m = monthKey(new Date(r.time));
    monthlyMaxByPeriod[m] ??= {};
    const prev = monthlyMaxByPeriod[m][r.period] ?? 0;
    if (r.kw > prev) monthlyMaxByPeriod[m][r.period] = r.kw;
  }

  // Días de facturación de cada mes de la ventana (intersección mes ∩ [from, to]).
  const daysByMonth = computeDaysByMonth(from, to);

  let sampleCount = 0;
  for (const pp of Object.keys(powerSamplesByPeriod)) sampleCount += powerSamplesByPeriod[pp].length;

  return {
    granularity,
    powerSamplesByPeriod,
    monthlyP99ByPeriod,
    monthlyMaxByPeriod,
    overContractedRatioByPeriod,
    daysByMonth,
    monthsWithData: monthsSeen.size,
    sampleCount,
    hasUsableData: curve.length > 0,
  };
}

function detectGranularity(curve: CurvePoint[]): 'hourly' | 'quarter' {
  if (curve.length < 2) return 'hourly';
  const times = curve.map(p => new Date(p.time).getTime()).sort((a, b) => a - b);
  let minDelta = Infinity;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  return minDelta <= 30 * 60_000 ? 'quarter' : 'hourly';
}

// Enumera los meses de [from, to] y cuenta los días de cada uno dentro de la ventana.
export function computeDaysByMonth(from: Date, to: Date): Record<string, number> {
  const out: Record<string, number> = {};
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor.getTime() <= to.getTime()) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(y, mo, 1));
    const monthEnd = new Date(Date.UTC(y, mo + 1, 0)); // último día del mes
    const lo = monthStart.getTime() > from.getTime() ? monthStart : from;
    const hi = monthEnd.getTime() < to.getTime() ? monthEnd : to;
    if (hi.getTime() >= lo.getTime()) {
      const days = Math.round((hi.getTime() - lo.getTime()) / 86_400_000) + 1;
      out[`${y}-${String(mo + 1).padStart(2, '0')}`] = days;
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

// ─── Implementación Flux contra InfluxDB ───────────────────────────────────────
export function makeInfluxOptimizationDataSource(queryApi: QueryApi): PowerOptimizationDataSource {
  return {
    async load(cups, from, to, tariff, contractedPower): Promise<PowerOptimizationSeries> {
      const range = `range(start: ${from.toISOString()}, stop: ${to.toISOString()})`;

      // Curva facturable (gap=false), sin agregar: cada punto es un intervalo de la curva.
      const curveFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}" and r._field == "kwh" and r.gap == "false")
          |> keep(columns: ["_time", "_value", "period"])
      `;
      // Maxímetro por período (un valor por mes y período).
      const maxPowerFlux = `
        from(bucket: "${bucket}")
          |> ${range}
          |> filter(fn: (r) => r._measurement == "max_power" and r.cups == "${cups}" and r._field == "kw")
          |> keep(columns: ["_time", "_value", "period"])
      `;

      const [curveRows, maxpRows] = await Promise.all([
        queryApi.collectRows<{ _time: string; _value: number; period: string }>(curveFlux),
        queryApi.collectRows<{ _time: string; _value: number; period: string }>(maxPowerFlux),
      ]);

      const curve: CurvePoint[] = curveRows.map(r => ({
        time: r._time,
        kwh: r._value,
        energyPeriod: r.period,
      }));
      const maxPowerRows = maxpRows.map(r => ({ time: r._time, kw: r._value, period: r.period }));

      return buildSeries(curve, maxPowerRows, from, to, tariff, contractedPower);
    },
  };
}
