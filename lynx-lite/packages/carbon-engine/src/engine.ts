import type { CarbonInput, CarbonMonthBucket, CarbonResult, Co2FactorHour } from './types.js';

// Media aritmética simple. 0 si no hay muestras.
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Cálculo puro de la huella de carbono (SPECS §7.4). Sin redondeo intermedio. El engine no conoce
// husos (recibe `month` resuelto) ni la fuente del factor (recibe `gPerKwh` ya compuesto).
//
// Las horas de consumo sin factor disponible se EXCLUYEN del cálculo (no entran en totales ni medias):
// la huella se reporta sobre las horas con factor. El servicio eleva CO2_NO_FACTOR_DATA si no hay
// ningún factor en todo el rango.
export function computeCarbonFootprint(input: CarbonInput): CarbonResult {
  const factorAt = new Map<string, number>();
  for (const f of input.factors) factorAt.set(f.ts, f.gPerKwh);

  interface Acc {
    key: string;
    startMs: number;
    kwh: number;
    co2Kg: number;
    sumKwhFactor: number; // Σ kwh·factor (para el factor medio ponderado del mes)
    hasGaps: boolean;
  }
  const acc = new Map<string, Acc>();

  let totalKwh = 0;
  let totalCo2Kg = 0;
  let sumKwhFactor = 0; // Σ kwh·factor global → factor propio ponderado
  const hourlyFactors: number[] = []; // un factor por hora considerada → media nacional

  for (const h of input.consumption) {
    const factor = factorAt.get(h.ts);
    if (factor === undefined) continue; // sin factor: se excluye

    const co2Kg = (h.kwh * factor) / 1000; // gCO₂ → kgCO₂
    totalKwh += h.kwh;
    totalCo2Kg += co2Kg;
    sumKwhFactor += h.kwh * factor;
    hourlyFactors.push(factor);

    const startMs = Date.parse(h.ts);
    const cur = acc.get(h.month) ?? { key: h.month, startMs, kwh: 0, co2Kg: 0, sumKwhFactor: 0, hasGaps: false };
    cur.kwh += h.kwh;
    cur.co2Kg += co2Kg;
    cur.sumKwhFactor += h.kwh * factor;
    if (h.gap) cur.hasGaps = true;
    if (startMs < cur.startMs) cur.startMs = startMs;
    acc.set(h.month, cur);
  }

  const months: CarbonMonthBucket[] = [...acc.values()]
    .map(b => ({
      key: b.key,
      monthStart: new Date(b.startMs).toISOString(),
      kwh: b.kwh,
      co2Kg: b.co2Kg,
      factorAvg: b.kwh > 0 ? b.sumKwhFactor / b.kwh : 0,
      hasGaps: b.hasGaps,
    }))
    .sort((a, b) => Date.parse(a.monthStart) - Date.parse(b.monthStart));

  const ownFactorGPerKwh = totalKwh > 0 ? sumKwhFactor / totalKwh : 0;
  const nationalAvgFactorGPerKwh = mean(hourlyFactors);
  const deltaPct =
    nationalAvgFactorGPerKwh > 0
      ? (ownFactorGPerKwh - nationalAvgFactorGPerKwh) / nationalAvgFactorGPerKwh
      : 0;

  return {
    months,
    totalKwh,
    totalCo2Kg,
    ownFactorGPerKwh,
    nationalAvgFactorGPerKwh,
    deltaPct,
    hasGaps: months.some(m => m.hasGaps),
  };
}

// Re-export para comodidad de los consumidores que sólo importan el engine.
export type { Co2FactorHour };
