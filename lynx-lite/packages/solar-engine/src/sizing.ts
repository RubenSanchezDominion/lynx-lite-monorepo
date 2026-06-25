// Optimizador de dimensionado (SPECS §8.10). Puro, sin I/O. Reutiliza `simulateSolar`.
// La producción escala LINEALMENTE con kWp: una sola serie a `kwpRef` y se escala por candidato.

import { simulateSolar } from './engine.js';
import type { SolarHour } from './types.js';
import { type FinancialParams, resolveFinancial, computeNpv } from './finance.js';

export interface SolarSizingInput {
  baseHours: SolarHour[]; // serie alineada a kwpRef (productionKwh por hora)
  kwpRef: number;
  surplusCompensationEurPerKwh: number;
  costPerKwp: number; // CAPEX = kwp × costPerKwp
  kwpMin: number;
  kwpMax: number;
  kwpStep: number;
  maxBudgetEur?: number;
  financial?: FinancialParams;
}

export interface SolarSizingPoint {
  kwp: number;
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number;
  coverageRatio: number;
  annualSavingEur: number;
  capexEur: number;
  npvEur: number;
  paybackYears: number | null;
}

export interface SolarSizingResult {
  curve: SolarSizingPoint[]; // un punto por kWp del grid
  recommendedKwp: number; // argmax(npvEur) bajo restricciones
  recommended: SolarSizingPoint;
  horizonYears: number;
  discountRatePct: number;
  degradationPctPerYear: number;
  priceEscalationPctPerYear: number;
}

export function optimizeSizing(input: SolarSizingInput): SolarSizingResult {
  const fin = resolveFinancial(input.financial);
  const step = input.kwpStep > 0 ? input.kwpStep : input.kwpMax - input.kwpMin || 1;
  const steps = Math.max(0, Math.floor((input.kwpMax - input.kwpMin) / step + 1e-9));

  const curve: SolarSizingPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const kwp = input.kwpMin + i * step;
    const capexEur = kwp * input.costPerKwp;
    // `!= null` cubre undefined Y null (el front envía null cuando no hay presupuesto fijado).
    if (input.maxBudgetEur != null && capexEur > input.maxBudgetEur + 1e-9) break;

    const factor = input.kwpRef !== 0 ? kwp / input.kwpRef : 0;
    const hours = input.baseHours.map(h => ({ ...h, productionKwh: h.productionKwh * factor }));
    const r = simulateSolar({
      hours,
      surplusCompensationEurPerKwh: input.surplusCompensationEurPerKwh,
      capexEur,
    });
    curve.push({
      kwp,
      annualProductionKwh: r.annualProductionKwh,
      annualSelfConsumptionKwh: r.annualSelfConsumptionKwh,
      annualSurplusKwh: r.annualSurplusKwh,
      selfConsumptionRatio: r.selfConsumptionRatio,
      coverageRatio: r.coverageRatio,
      annualSavingEur: r.annualSavingEur,
      capexEur,
      npvEur: computeNpv(r.annualSavingEur, capexEur, fin),
      paybackYears: r.paybackYears,
    });
  }

  // argmax(npvEur). Si el grid quedó vacío (restricciones imposibles), recommended es null-safe.
  let recommended = curve[0];
  for (const p of curve) if (p.npvEur > recommended.npvEur) recommended = p;

  return {
    curve,
    recommendedKwp: recommended ? recommended.kwp : input.kwpMin,
    recommended,
    horizonYears: fin.horizonYears,
    discountRatePct: fin.discountRatePct,
    degradationPctPerYear: fin.degradationPctPerYear,
    priceEscalationPctPerYear: fin.priceEscalationPctPerYear,
  };
}
