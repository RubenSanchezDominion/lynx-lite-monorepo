import { describe, it, expect } from 'vitest';
import { computeExcessTerm } from '../src/excess.js';
import type { ExcessTermInput } from '../src/types.js';

function expectEur(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01);
}

const BASE: ExcessTermInput = {
  modePowerControl: 'MAXIMETRO',
  contractedPower: { P1: 50, P2: 50, P3: 50, P4: 50, P5: 50, P6: 50 },
  maxPower: { P1: 58, P2: 47, P3: 49, P4: 46, P5: 48, P6: 47 },
  excessRates: { P1: 0.07, P2: 0.06, P3: 0.04, P4: 0.04, P5: 0.02, P6: 0.02 },
  days: 30,
};

describe('computeExcessTerm — fórmula real art. 9.4.b.1 (tipos 4 y 5)', () => {
  it('ICP → total 0 sin líneas', () => {
    const r = computeExcessTerm({ ...BASE, modePowerControl: 'ICP' });
    expect(r.total).toBe(0);
    expect(r.lines).toHaveLength(0);
  });

  it('maxPower null → total 0', () => {
    const r = computeExcessTerm({ ...BASE, maxPower: null });
    expect(r.total).toBe(0);
    expect(r.lines).toHaveLength(0);
  });

  it('solo factura períodos con Pdp > Pcp (P1)', () => {
    const r = computeExcessTerm(BASE);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].period).toBe(1);
    // (58 − 50) × 0.07 × 30 = 16.80
    expectEur(r.total, 16.8);
  });

  it('Pdp == Pcp no factura (sin banda 1.05)', () => {
    const r = computeExcessTerm({ ...BASE, maxPower: { ...BASE.maxPower!, P1: 50 } });
    expect(r.total).toBe(0);
  });

  it('Pdp ligeramente por encima factura (sin tolerancia)', () => {
    const r = computeExcessTerm({ ...BASE, maxPower: { ...BASE.maxPower!, P1: 50.5 } });
    // (50.5 − 50) × 0.07 × 30 = 1.05
    expectEur(r.total, 1.05);
  });

  it('suma varios períodos en exceso', () => {
    const r = computeExcessTerm({ ...BASE, maxPower: { P1: 60, P2: 60, P3: 49, P4: 46, P5: 48, P6: 47 } });
    // P1: 10×0.07×30=21.00 ; P2: 10×0.06×30=18.00 → 39.00
    expect(r.lines).toHaveLength(2);
    expectEur(r.total, 39.0);
  });
});
