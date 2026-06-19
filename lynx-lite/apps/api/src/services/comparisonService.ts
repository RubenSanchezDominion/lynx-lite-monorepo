import {
  computePreInvoice,
  type ComputedPreInvoice,
  type PreInvoiceDeps,
} from './preInvoiceService.js';

// ─── M07 — Comparativa de suministros ─────────────────────────────────────────
//
// No hay lógica de dominio nueva: una comparación es "calcular dos pre-facturas
// (M01) y restar". Este servicio orquesta dos `computePreInvoice` y calcula los
// deltas (B − A) sin redondeo intermedio (SPECS §9.4). No persiste nada.

export interface ComparisonDelta {
  totalA: number;
  totalB: number;
  deltaTotal: number;
  deltaTotalPct: number | null; // (deltaTotal / totalA) × 100; null si totalA = 0
  powerTermDelta: number;
  energyTermDelta: number;
  excessPowerDelta: number;
  reactiveDelta: number | null; // null si ambos lados sin reactiva
  meterRentalDelta: number;
  taxesDelta: number; // (iee+iva) de B − (iee+iva) de A
  kwhA: number;
  kwhB: number;
  avgCostPerKwhA: number | null; // total / kwh; null si kwh = 0
  avgCostPerKwhB: number | null;
  deltaCostPerKwh: number | null; // avgCostB − avgCostA; null si falta alguno
  sameTariff: boolean;
}

export interface ComparisonResult {
  a: ComputedPreInvoice;
  b: ComputedPreInvoice;
  delta: ComparisonDelta;
}

export interface ComparisonInput {
  a: { cups: string; periodFrom: string; periodTo: string };
  b: { cups: string; periodFrom: string; periodTo: string };
}

// kWh consumidos de un lado = suma de las líneas de energía (unit 'kWh').
function energyKwh(c: ComputedPreInvoice): number {
  return c.pricing.lines
    .filter(l => l.unit === 'kWh')
    .reduce((sum, l) => sum + l.quantity, 0);
}

// Reactiva aplicada del lado (null si no se aplicó), igual que el mapeo GraphQL.
function reactiveOf(c: ComputedPreInvoice): number | null {
  return c.reactiveApplied ? c.pricing.reactiveEnergy : null;
}

function avgCost(total: number, kwh: number): number | null {
  return kwh > 0 ? total / kwh : null;
}

export async function computeComparison(
  input: ComparisonInput,
  deps: PreInvoiceDeps,
): Promise<ComparisonResult> {
  const a = await computePreInvoice(input.a, deps);
  const b = await computePreInvoice(input.b, deps);

  const pa = a.pricing;
  const pb = b.pricing;

  const kwhA = energyKwh(a);
  const kwhB = energyKwh(b);
  const avgCostPerKwhA = avgCost(pa.total, kwhA);
  const avgCostPerKwhB = avgCost(pb.total, kwhB);

  const reactA = reactiveOf(a);
  const reactB = reactiveOf(b);
  const reactiveDelta =
    reactA === null && reactB === null ? null : (reactB ?? 0) - (reactA ?? 0);

  const deltaTotal = pb.total - pa.total;

  const delta: ComparisonDelta = {
    totalA: pa.total,
    totalB: pb.total,
    deltaTotal,
    deltaTotalPct: pa.total !== 0 ? (deltaTotal / pa.total) * 100 : null,
    powerTermDelta: pb.powerTerm - pa.powerTerm,
    energyTermDelta: pb.energyTerm - pa.energyTerm,
    excessPowerDelta: pb.excessPower - pa.excessPower,
    reactiveDelta,
    meterRentalDelta: pb.meterRental - pa.meterRental,
    taxesDelta: pb.ieeAmount + pb.vatAmount - (pa.ieeAmount + pa.vatAmount),
    kwhA,
    kwhB,
    avgCostPerKwhA,
    avgCostPerKwhB,
    deltaCostPerKwh:
      avgCostPerKwhA === null || avgCostPerKwhB === null
        ? null
        : avgCostPerKwhB - avgCostPerKwhA,
    sameTariff: a.tariff === b.tariff,
  };

  return { a, b, delta };
}
