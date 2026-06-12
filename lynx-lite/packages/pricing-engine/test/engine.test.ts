import { describe, it, expect } from 'vitest';
import { calculate } from '../src/engine.js';
import type { PricingInput } from '../src/types.js';

// Tolerancia ±0.01 € según SPECS §3.4
function expectEur(actual: number, expected: number, label = '') {
  expect(Math.abs(actual - expected), label || `expected ${expected}, got ${actual}`)
    .toBeLessThanOrEqual(0.01);
}

// ─── Fixtures base ────────────────────────────────────────────────────────────

const BASE_2_0TD: PricingInput = {
  tariff: 'T_2_0TD',
  periodDays: 31,
  modePowerControl: 'ICP',
  contractedPower: { P1: 10.0, P2: 10.0 },
  consumption: { P1: 500.0, P2: 800.0, P3: 1200.0 },
  maxPower: null,
  excessRates: { P1: 0.060000, P2: 0.060000 }, // tepp4-5 €/kW·día (sintético)
  pvpcPrice: { P1: 0.14000, P2: 0.10000, P3: 0.06000 },
  tollRates: {
    power: { P1: 0.115327, P2: 0.002572 },
    energy: { P1: 0.007215, P2: 0.004860, P3: 0.000841 },
  },
  chargeRates: {
    power: { P1: 0.011000, P2: 0.001000 },
    energy: { P1: 0.003000, P2: 0.002000, P3: 0.001000 },
  },
  ieeRate: 0.0511269632,
  vatRate: 0.21,
  meterRentalPerDay: 0.026114,
  reactiveEnergy: null,
  reactiveRates: null,
  hasSurplus: false,
};

const BASE_3_0TD: PricingInput = {
  tariff: 'T_3_0TD',
  periodDays: 30,
  modePowerControl: 'MAXIMETRO',
  contractedPower: { P1: 50, P2: 50, P3: 50, P4: 50, P5: 50, P6: 50 },
  consumption: { P1: 2000, P2: 3000, P3: 4000, P4: 1500, P5: 2500, P6: 5000 },
  maxPower: { P1: 48, P2: 47, P3: 49, P4: 46, P5: 48, P6: 47 },
  excessRates: { P1: 0.070000, P2: 0.060000, P3: 0.040000, P4: 0.040000, P5: 0.020000, P6: 0.020000 }, // tepp4-5 €/kW·día (sintético)
  pvpcPrice: { P1: 0.18, P2: 0.14, P3: 0.10, P4: 0.16, P5: 0.12, P6: 0.07 },
  tollRates: {
    power: { P1: 0.115327, P2: 0.082748, P3: 0.024894, P4: 0.024894, P5: 0.003695, P6: 0.002572 },
    energy: { P1: 0.009518, P2: 0.006872, P3: 0.003558, P4: 0.003558, P5: 0.002122, P6: 0.000841 },
  },
  chargeRates: {
    power: { P1: 0.015000, P2: 0.010000, P3: 0.006000, P4: 0.006000, P5: 0.002000, P6: 0.001000 },
    energy: { P1: 0.005000, P2: 0.004000, P3: 0.003000, P4: 0.003000, P5: 0.002000, P6: 0.001000 },
  },
  ieeRate: 0.0511269632,
  vatRate: 0.21,
  meterRentalPerDay: 0.039660,
  reactiveEnergy: null,
  reactiveRates: null,
  hasSurplus: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertLinesOrdered(lines: { sortOrder: number }[]) {
  for (let i = 1; i < lines.length; i++) {
    expect(lines[i].sortOrder).toBeGreaterThan(lines[i - 1].sortOrder);
  }
}

function assertLineSumEqualsTotal(lines: { amount: number }[], total: number) {
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  expectEur(sum, total, 'sum(lines.amount) debe igualar total');
}

// ─── TC-PRE-001 — 2.0TD básico, sin excesos, sin reactiva ────────────────────

describe('TC-PRE-001 — 2.0TD básico, ICP, sin reactiva', () => {
  const result = calculate(BASE_2_0TD);

  it('powerTerm', () => expectEur(result.powerTerm, 40.27));
  it('energyTerm', () => expectEur(result.energyTerm, 234.81));
  it('excessPower es 0', () => expect(result.excessPower).toBe(0));
  it('meterRental', () => expectEur(result.meterRental, 0.81));
  it('ieeBase', () => expectEur(result.ieeBase, 275.08));
  it('ieeAmount', () => expectEur(result.ieeAmount, 14.06));
  it('subtotal', () => expectEur(result.subtotal, 289.95));
  it('vatAmount', () => expectEur(result.vatAmount, 60.89));
  it('total', () => expectEur(result.total, 350.84));
  it('reactiveEnergy output es 0', () => expect(result.reactiveEnergy).toBe(0));
  it('8 líneas (2 potencia + 3 energía + alquiler + IEE + IVA)', () => {
    expect(result.lines).toHaveLength(8);
  });
  it('líneas ordenadas por sortOrder', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
});

// ─── TC-PRE-002 — 2.0TD con exceso de potencia en P1 ────────────────────────

describe('TC-PRE-002 — 2.0TD, MAXIMETRO, exceso en P1', () => {
  const input: PricingInput = {
    ...BASE_2_0TD,
    modePowerControl: 'MAXIMETRO',
    maxPower: { P1: 11.5, P2: 9.5 },
  };
  const result = calculate(input);

  it('powerTerm igual TC-PRE-001', () => expectEur(result.powerTerm, 40.27));
  it('energyTerm igual TC-PRE-001', () => expectEur(result.energyTerm, 234.81));
  // Exceso P1 = (11.5 − 10) × 0.060000 €/kW·día × 31 días = 2.79 € (fórmula real art. 9.4.b.1)
  it('excessPower total', () => expectEur(result.excessPower, 2.79));
  it('ieeBase', () => expectEur(result.ieeBase, 277.86));
  it('ieeAmount', () => expectEur(result.ieeAmount, 14.21));
  it('subtotal', () => expectEur(result.subtotal, 292.88));
  it('vatAmount', () => expectEur(result.vatAmount, 61.50));
  it('total', () => expectEur(result.total, 354.38));
  it('9 líneas (añade exceso P1)', () => {
    expect(result.lines).toHaveLength(9);
  });
  it('líneas ordenadas', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
  it('P2 no genera exceso (9.5 ≤ 10 contratada)', () => {
    const excessLines = result.lines.filter(l => l.concept.startsWith('Exceso'));
    expect(excessLines).toHaveLength(1);
    expect(excessLines[0].period).toBe(1);
  });
});

// ─── TC-PRE-003 — 3.0TD sin excesos ─────────────────────────────────────────

describe('TC-PRE-003 — 3.0TD, MAXIMETRO, sin excesos, sin reactiva', () => {
  const result = calculate(BASE_3_0TD);

  it('powerTerm (P1)', () => {
    const p1 = result.lines.find(l => l.concept === 'Término de potencia P1')!;
    expectEur(p1.amount, 195.49);
  });
  it('powerTerm (P6)', () => {
    const p6 = result.lines.find(l => l.concept === 'Término de potencia P6')!;
    expectEur(p6.amount, 5.36);
  });
  it('powerTerm total', () => expectEur(result.powerTerm, 441.19));
  it('energyTerm (P1)', () => {
    const p1 = result.lines.find(l => l.concept === 'Término de energía P1')!;
    expectEur(p1.amount, 389.04);
  });
  it('energyTerm total', () => expectEur(result.energyTerm, 2187.23));
  it('excessPower es 0 (todos dentro del umbral)', () => expect(result.excessPower).toBe(0));
  it('meterRental', () => expectEur(result.meterRental, 1.19));
  it('ieeBase', () => expectEur(result.ieeBase, 2628.43));
  it('ieeAmount', () => expectEur(result.ieeAmount, 134.38));
  it('subtotal', () => expectEur(result.subtotal, 2764.00));
  it('vatAmount', () => expectEur(result.vatAmount, 580.44));
  it('total', () => expectEur(result.total, 3344.44));
  it('15 líneas (6 potencia + 6 energía + alquiler + IEE + IVA)', () => {
    expect(result.lines).toHaveLength(15);
  });
  it('líneas ordenadas', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
});

// ─── TC-PRE-004 — 3.0TD con exceso en P1 ────────────────────────────────────

describe('TC-PRE-004 — 3.0TD, exceso en P1', () => {
  const input: PricingInput = {
    ...BASE_3_0TD,
    maxPower: { P1: 58.0, P2: 47.0, P3: 49.0, P4: 46.0, P5: 48.0, P6: 47.0 },
  };
  const result = calculate(input);

  it('powerTerm igual TC-PRE-003', () => expectEur(result.powerTerm, 441.19));
  it('energyTerm igual TC-PRE-003', () => expectEur(result.energyTerm, 2187.23));
  // Exceso P1 = (58 − 50) × 0.070000 €/kW·día × 30 días = 16.80 € (fórmula real art. 9.4.b.1)
  it('excessPower (P1)', () => expectEur(result.excessPower, 16.80));
  it('ieeBase', () => expectEur(result.ieeBase, 2645.23));
  it('ieeAmount', () => expectEur(result.ieeAmount, 135.24));
  it('subtotal', () => expectEur(result.subtotal, 2781.66));
  it('vatAmount', () => expectEur(result.vatAmount, 584.15));
  it('total', () => expectEur(result.total, 3365.81));
  it('solo línea de exceso en P1', () => {
    const excessLines = result.lines.filter(l => l.concept.startsWith('Exceso'));
    expect(excessLines).toHaveLength(1);
    expect(excessLines[0].period).toBe(1);
  });
  it('líneas ordenadas', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
});

// ─── TC-PRE-009 — 3.0TD reactiva tramo 1 en P1 ──────────────────────────────

describe('TC-PRE-009 — 3.0TD, reactiva tramo 1 en P1 (0,80 ≤ cos φ < 0,95)', () => {
  const input: PricingInput = {
    ...BASE_3_0TD,
    reactiveEnergy: { P1: 900, P2: 500, P3: 800, P4: 400, P5: 600, P6: 1000 },
    reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 },
  };
  const result = calculate(input);

  it('powerTerm igual TC-PRE-003', () => expectEur(result.powerTerm, 441.19));
  it('energyTerm igual TC-PRE-003', () => expectEur(result.energyTerm, 2187.23));
  it('excessPower es 0', () => expect(result.excessPower).toBe(0));
  it('reactiveEnergy (P1 tier 1)', () => expectEur(result.reactiveEnergy, 9.97));
  it('ieeBase', () => expectEur(result.ieeBase, 2638.40));
  it('ieeAmount', () => expectEur(result.ieeAmount, 134.89));
  it('subtotal', () => expectEur(result.subtotal, 2774.49));
  it('vatAmount', () => expectEur(result.vatAmount, 582.64));
  it('total', () => expectEur(result.total, 3357.13));
  it('16 líneas (15 de TC-PRE-003 + 1 reactiva P1)', () => {
    expect(result.lines).toHaveLength(16);
  });
  it('solo línea de reactiva en P1', () => {
    const reactiveLines = result.lines.filter(l => l.concept.startsWith('Energía reactiva'));
    expect(reactiveLines).toHaveLength(1);
    expect(reactiveLines[0].period).toBe(1);
  });
  it('P2-P5 sin línea de reactiva (ratio ≤ 0,33)', () => {
    const reactiveLines = result.lines.filter(l => l.concept.startsWith('Energía reactiva'));
    const periods = reactiveLines.map(l => l.period);
    expect(periods).not.toContain(2);
    expect(periods).not.toContain(3);
    expect(periods).not.toContain(4);
    expect(periods).not.toContain(5);
  });
  it('líneas ordenadas', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
});

// ─── TC-PRE-010 — 3.0TD reactiva tramo 2 en P1 ──────────────────────────────

describe('TC-PRE-010 — 3.0TD, reactiva tramo 2 en P1 (cos φ < 0,80)', () => {
  const input: PricingInput = {
    ...BASE_3_0TD,
    reactiveEnergy: { P1: 1600, P2: 500, P3: 800, P4: 400, P5: 600, P6: 1000 },
    reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 },
  };
  const result = calculate(input);

  it('powerTerm igual TC-PRE-003', () => expectEur(result.powerTerm, 441.19));
  it('energyTerm igual TC-PRE-003', () => expectEur(result.energyTerm, 2187.23));
  it('reactiveEnergy (P1 tier 2)', () => expectEur(result.reactiveEnergy, 58.59));
  it('ieeBase', () => expectEur(result.ieeBase, 2687.02));
  it('ieeAmount', () => expectEur(result.ieeAmount, 137.38));
  it('subtotal', () => expectEur(result.subtotal, 2825.59));
  it('vatAmount', () => expectEur(result.vatAmount, 593.38));
  it('total', () => expectEur(result.total, 3418.96));
  it('16 líneas', () => expect(result.lines).toHaveLength(16));
  it('líneas ordenadas', () => assertLinesOrdered(result.lines));
  it('sum(lines.amount) === total', () => assertLineSumEqualsTotal(result.lines, result.total));
});

// ─── TC-PRE-023 — P6 excluido del cálculo de reactiva ────────────────────────

describe('TC-PRE-023 — P6 excluido de energía reactiva (precio regulado = 0)', () => {
  const input009: PricingInput = {
    ...BASE_3_0TD,
    reactiveEnergy: { P1: 900, P2: 500, P3: 800, P4: 400, P5: 600, P6: 1000 },
    reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 },
  };
  const input023: PricingInput = {
    ...BASE_3_0TD,
    reactiveEnergy: { P1: 900, P2: 500, P3: 800, P4: 400, P5: 600, P6: 5000 },
    reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 },
  };
  const result009 = calculate(input009);
  const result023 = calculate(input023);

  it('reactiveCharge[P6] === 0', () => {
    const p6Line = result023.lines.find(l => l.concept === 'Energía reactiva P6');
    expect(p6Line).toBeUndefined();
  });
  it('reactiveEnergy total idéntico a TC-PRE-009', () => {
    expectEur(result023.reactiveEnergy, result009.reactiveEnergy);
  });
  it('total idéntico a TC-PRE-009', () => {
    expectEur(result023.total, result009.total);
  });
});
