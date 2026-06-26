import type { CanonicalPoint, MonthPerformance, PerformanceInput, PerformanceResult } from './types.js';

// Compara la producción MEDIDA con el baseline ESPERADO (PVGIS) → PR, kWh/kWp y desviación mensual.
// Puro, sin redondeo intermedio (criterio §8.4). Solo entran al ratio las horas medidas que tienen
// baseline esperado de la misma hora (alineadas aguas arriba por el servicio).
export function comparePerformance(input: PerformanceInput): PerformanceResult {
  const threshold = input.underperformanceThreshold ?? 0.85;

  const expByTs = new Map<string, number>();
  for (const e of input.expected) expByTs.set(e.ts, (expByTs.get(e.ts) ?? 0) + e.kwh);

  let measuredKwh = 0;
  let expectedKwh = 0;
  const months = new Map<string, { m: number; e: number }>();

  for (const p of input.measured) {
    const exp = expByTs.get(p.ts);
    if (exp === undefined) continue; // sin baseline para esa hora → fuera del ratio
    measuredKwh += p.kwh;
    expectedKwh += exp;
    const key = p.ts.slice(0, 7); // "YYYY-MM" (UTC; suficiente para localizar la caída)
    const acc = months.get(key) ?? { m: 0, e: 0 };
    acc.m += p.kwh;
    acc.e += exp;
    months.set(key, acc);
  }

  const performanceRatio = expectedKwh > 0 ? measuredKwh / expectedKwh : 0;
  const specificYieldKwhPerKwp = input.kwp > 0 ? measuredKwh / input.kwp : 0;
  const monthList: MonthPerformance[] = [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({ key, measuredKwh: v.m, expectedKwh: v.e, ratio: v.e > 0 ? v.m / v.e : 0 }));

  const underperforming = expectedKwh > 0 && performanceRatio < threshold;
  const underperformancePct = Math.max(0, 1 - performanceRatio) * 100;

  return {
    measuredKwh,
    expectedKwh,
    performanceRatio,
    specificYieldKwhPerKwp,
    months: monthList,
    underperforming,
    underperformancePct,
  };
}

// Alinea una serie PVGIS de "año tipo" a las fechas de la serie medida, por (mes, día, hora) UTC, igual
// que §8.4. Devuelve la serie esperada con los MISMOS ts que la medida (lista para comparePerformance).
// `typical` es la producción esperada indexada por clave (mes,día,hora). Helper para el servicio.
export function alignExpectedToMeasured(
  measured: CanonicalPoint[],
  typicalByKey: Map<string, number>,
): CanonicalPoint[] {
  const out: CanonicalPoint[] = [];
  for (const p of measured) {
    const d = new Date(p.ts);
    let day = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const hour = d.getUTCHours();
    if (month === 2 && day === 29) day = 28;
    const kwh = typicalByKey.get(`${month}-${day}-${hour}`);
    if (kwh !== undefined) out.push({ ts: p.ts, kwh });
  }
  return out;
}
