import { computePowerTerm, computeExcessTerm } from '@lynx-lite/pricing-engine';
import type { OptimizationInput, OptimizationResult, OptimizationPeriod } from './types.js';

const DAY_MS = 86_400_000;

// Percentil por interpolación lineal (método "linear" / R-7, el de numpy.percentile).
// rango = (p/100)·(n−1); valor = v[floor] + frac·(v[ceil] − v[floor]). Fija el método para
// evitar ambigüedad entre implementaciones (SPECS §4.4 Paso 1).
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const frac = rank - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return sorted[lower] + frac * (sorted[lower + 1] - sorted[lower]);
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Coste de excesos sobre los meses reales de la ventana, con la fórmula regulatoria real
// (art. 9.4.b.1). `power` son las potencias (contratadas u óptimas) a evaluar como Pcp.
function excessCost(input: OptimizationInput, power: Record<string, number>): number {
  let total = 0;
  for (const month of Object.keys(input.monthlyMaxByPeriod)) {
    const { total: monthTotal } = computeExcessTerm({
      modePowerControl: input.modePowerControl,
      contractedPower: power,
      maxPower: input.monthlyMaxByPeriod[month],
      excessRates: input.excessRatesPower,
      days: input.daysByMonth[month] ?? 0,
    });
    total += monthTotal;
  }
  return total;
}

export function optimizePower(input: OptimizationInput): OptimizationResult {
  const oversizeFactor = input.oversizeFactor ?? 0.7;
  const oversizeMonths = input.oversizeMonths ?? 6;
  const undersizeRatio = input.undersizeRatio ?? 0.02;
  const minSavingEur = input.minSavingEur ?? 0;
  const uplift = input.granularity === 'hourly' ? 1.05 : 1.0;

  const periods = Object.keys(input.contractedPower).sort();
  const months = Object.keys(input.monthlyP99ByPeriod).sort();

  // Paso 1 — Percentil 99 + uplift
  const p99: Record<string, number> = {};
  const optimalRaw: Record<string, number> = {};
  let sampleCount = 0;
  for (const p of periods) {
    const samples = input.powerSamplesByPeriod[p] ?? [];
    sampleCount += samples.length;
    p99[p] = percentile(samples, 99);
    optimalRaw[p] = p99[p] * uplift;
  }

  // Paso 2 — Monotonía P1 ≤ P2 ≤ … ≤ PN
  const optimalPower: Record<string, number> = {};
  let prev = -Infinity;
  for (const p of periods) {
    const v = Math.max(prev, optimalRaw[p]);
    optimalPower[p] = v;
    prev = v;
  }

  // Paso 3 — Diagnóstico por período
  const resultPeriods: OptimizationPeriod[] = [];
  for (const p of periods) {
    const periodNum = parseInt(p.slice(1), 10);
    const current = input.contractedPower[p];

    let observedMax = 0;
    for (const m of months) {
      const v = input.monthlyMaxByPeriod[m]?.[p];
      if (v !== undefined && v > observedMax) observedMax = v;
    }

    const marginPct = current !== 0 ? ((optimalPower[p] - current) / current) * 100 : 0;

    // Sobredimensionado: racha de meses consecutivos con p99 mensual < factor × Pc
    let run = 0;
    let maxRun = 0;
    for (const m of months) {
      const v = input.monthlyP99ByPeriod[m]?.[p];
      if (v !== undefined && v < oversizeFactor * current) {
        run += 1;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    const oversized = maxRun >= oversizeMonths;

    // Infradimensionado: algún mes con fracción de intervalos en exceso > undersizeRatio
    let undersized = false;
    for (const m of Object.keys(input.overContractedRatioByPeriod)) {
      const ratio = input.overContractedRatioByPeriod[m]?.[p];
      if (ratio !== undefined && ratio > undersizeRatio) {
        undersized = true;
        break;
      }
    }

    // UNDERSIZED tiene prioridad sobre OVERSIZED
    const diagnosis: OptimizationPeriod['diagnosis'] = undersized
      ? 'UNDERSIZED'
      : oversized
        ? 'OVERSIZED'
        : 'OK';

    resultPeriods.push({
      period: periodNum,
      currentPower: current,
      optimalPower: optimalPower[p],
      p99Power: p99[p],
      observedMax,
      diagnosis,
      marginPct,
    });
  }

  // Paso 4 — Ahorro estimado (reutiliza computePowerTerm y computeExcessTerm)
  const powerTermCurrent = computePowerTerm(
    input.contractedPower,
    input.tollRatesPower,
    input.chargeRatesPower,
    365,
  ).total;
  const powerTermOptimal = computePowerTerm(
    optimalPower,
    input.tollRatesPower,
    input.chargeRatesPower,
    365,
  ).total;
  const fixedSaving = powerTermCurrent - powerTermOptimal;

  const excessSaving = excessCost(input, input.contractedPower) - excessCost(input, optimalPower);

  const annualSaving = fixedSaving + excessSaving;
  const hasDeviation = resultPeriods.some(p => p.diagnosis !== 'OK');
  const recommendChange = annualSaving > minSavingEur && hasDeviation;

  // Paso 5 — Restricción de un cambio de potencia al año
  let changeAllowed = true;
  let changeBlockedUntil: string | null = null;
  if (input.lastPowerChangeDate !== null) {
    const lastChange = new Date(input.lastPowerChangeDate);
    const analysisTo = new Date(input.analysisTo);
    const elapsedDays = (analysisTo.getTime() - lastChange.getTime()) / DAY_MS;
    if (elapsedDays < 365) {
      changeAllowed = false;
      changeBlockedUntil = toISODate(new Date(lastChange.getTime() + 365 * DAY_MS));
    }
  }

  return {
    periods: resultPeriods,
    fixedSaving,
    excessSaving,
    annualSaving,
    recommendChange,
    changeAllowed,
    changeBlockedUntil,
    upliftFactor: uplift,
    sampleCount,
  };
}
