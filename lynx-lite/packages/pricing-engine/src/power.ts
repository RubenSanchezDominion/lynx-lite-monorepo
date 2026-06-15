import type { PricingLine } from './types.js';

export interface PowerTermResult {
  total: number;
  lines: PricingLine[];
}

// Término de potencia contratada (Paso 1 de §3.4): por cada período de potencia,
//   importe = potencia(kW) × días × (peaje + cargo)(€/kW·día)
// Función pura sin I/O. La comparten M01 (`calculate`, un tramo de facturación) y M02
// (optimización, anualizada a 365 días). `sortOffset` permite continuar la numeración de
// líneas del llamante; si no se pasa, las líneas empiezan en sortOrder 1.
export function computePowerTerm(
  power: Record<string, number>,
  tollPower: Record<string, number>,
  chargePower: Record<string, number>,
  days: number,
  sortOffset = 0,
): PowerTermResult {
  const periods = Object.keys(power).sort();
  const lines: PricingLine[] = [];
  let total = 0;
  let sortOrder = sortOffset;

  for (const p of periods) {
    const periodNum = parseInt(p.slice(1), 10);
    const rate = (tollPower[p] ?? 0) + (chargePower[p] ?? 0);
    const kwDays = power[p] * days;
    const amount = kwDays * rate;
    total += amount;
    lines.push({
      concept: `Término de potencia ${p}`,
      period: periodNum,
      quantity: kwDays,
      unit: 'kW·día',
      unitPrice: rate,
      amount,
      sortOrder: ++sortOrder,
    });
  }

  return { total, lines };
}
