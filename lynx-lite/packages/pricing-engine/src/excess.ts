import type { ExcessTermInput, ExcessTermResult, ExcessTermLine } from './types.js';

// Facturación por exceso de potencia para puntos de medida tipo 4 y 5 (2.0TD/3.0TD),
// art. 9.4.b.1 de la Circular CNMC 3/2020 consolidada (vigente desde 1-abril-2025):
//
//   FEP = Σp  tepp4-5 × (Pdp − Pcp) × n     (solo períodos con Pdp > Pcp)
//
// Sin raíz cuadrada, sin factor ×2 y sin banda del 1.05 (esa banda era del RD 1164/2001,
// derogado). Con ICP no hay excesos (salta el interruptor) → total 0.
// Función pura sin I/O: la usan M01 (un tramo = período de facturación) y M02 (un tramo
// por mes, sumando los resultados).
export function computeExcessTerm(input: ExcessTermInput): ExcessTermResult {
  if (input.modePowerControl !== 'MAXIMETRO' || input.maxPower === null) {
    return { total: 0, lines: [] };
  }

  const periods = Object.keys(input.contractedPower).sort();
  const lines: ExcessTermLine[] = [];
  let total = 0;

  for (const p of periods) {
    const contracted = input.contractedPower[p];
    const measured = input.maxPower[p] ?? 0;
    if (measured <= contracted) continue;

    const excessKw = measured - contracted;
    const tepPerDay = input.excessRates[p] ?? 0;
    const amount = excessKw * tepPerDay * input.days;
    total += amount;
    lines.push({
      period: parseInt(p.slice(1), 10),
      excessKw,
      tepPerDay,
      days: input.days,
      amount,
    });
  }

  return { total, lines };
}
