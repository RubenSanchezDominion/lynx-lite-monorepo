// Optimizador de orientación/inclinación (SPECS §8.11). Puro, sin I/O. Reutiliza `simulateSolar`.
// El servicio obtiene una serie por candidato (seriescalc, cada tilt/azimut tiene forma distinta) y
// construye `hours` a kWp fijo; aquí solo se corre la simulación y se rankea por VAN del autoconsumo.

import { simulateSolar } from './engine.js';
import type { SolarHour } from './types.js';
import { type FinancialParams, resolveFinancial, computeNpv } from './finance.js';

export interface OrientationCandidate {
  tilt: number;
  azimuth: number;
  label?: string;
}

export interface SolarOrientationInput {
  perCandidate: Array<{ candidate: OrientationCandidate; hours: SolarHour[] }>; // hours a kWp fijo
  surplusCompensationEurPerKwh: number;
  capexEur: number;
  financial?: FinancialParams;
}

export interface SolarOrientationPoint extends OrientationCandidate {
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  selfConsumptionRatio: number;
  annualSavingEur: number;
  npvEur: number;
}

export interface SolarOrientationResult {
  candidates: SolarOrientationPoint[]; // todos los evaluados
  recommended: SolarOrientationPoint; // argmax(npvEur)
}

export function optimizeOrientation(input: SolarOrientationInput): SolarOrientationResult {
  const fin = resolveFinancial(input.financial);

  const candidates: SolarOrientationPoint[] = input.perCandidate.map(({ candidate, hours }) => {
    const r = simulateSolar({
      hours,
      surplusCompensationEurPerKwh: input.surplusCompensationEurPerKwh,
      capexEur: input.capexEur,
    });
    return {
      tilt: candidate.tilt,
      azimuth: candidate.azimuth,
      label: candidate.label,
      annualProductionKwh: r.annualProductionKwh,
      annualSelfConsumptionKwh: r.annualSelfConsumptionKwh,
      selfConsumptionRatio: r.selfConsumptionRatio,
      annualSavingEur: r.annualSavingEur,
      npvEur: computeNpv(r.annualSavingEur, input.capexEur, fin),
    };
  });

  let recommended = candidates[0];
  for (const c of candidates) if (c.npvEur > recommended.npvEur) recommended = c;

  return { candidates, recommended };
}
