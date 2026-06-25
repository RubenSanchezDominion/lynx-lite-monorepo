import { describe, it, expect } from 'vitest';
import { optimizeSizing } from '../src/index.js';
import type { SolarHour, SolarSizingInput } from '../src/index.js';

function h(hour: number, consumptionKwh: number, productionKwh: number, eurPerKwh = 0.2): SolarHour {
  const ts = `2025-06-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return { ts, month: '2025-06', consumptionKwh, productionKwh, eurPerKwh };
}
function makeSizing(over: Partial<SolarSizingInput>): SolarSizingInput {
  return {
    baseHours: [],
    kwpRef: 1,
    surplusCompensationEurPerKwh: 0,
    costPerKwp: 1000,
    kwpMin: 1,
    kwpMax: 1,
    kwpStep: 1,
    ...over,
  };
}

describe('TC-SOL-017 — VAN sin descuento = ahorro·N − CAPEX', () => {
  it('disc=deg=esc=0, N=25 ⇒ npv = annualSavingEur·25 − capexEur', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 1000, 1, 0.2)], // consumo enorme → todo autoconsumido
      kwpRef: 1, kwpMin: 1, kwpMax: 1, kwpStep: 1, costPerKwp: 1000,
      financial: { horizonYears: 25, discountRatePct: 0, degradationPctPerYear: 0, priceEscalationPctPerYear: 0 },
    }));
    const p = r.curve[0];
    expect(p.npvEur).toBeCloseTo(p.annualSavingEur * 25 - p.capexEur, 6);
  });
});

describe('TC-SOL-018 — VAN con descuento y degradación (serie geométrica)', () => {
  it('N=2, disc=10%, ahorro=121, capex=0 ⇒ npv = 110 + 100 = 210', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 1000, 605, 0.2)], // self=605 → ahorro=121
      kwpRef: 1, kwpMin: 1, kwpMax: 1, kwpStep: 1, costPerKwp: 0,
      financial: { horizonYears: 2, discountRatePct: 10, degradationPctPerYear: 0, priceEscalationPctPerYear: 0 },
    }));
    const p = r.curve[0];
    expect(p.annualSavingEur).toBeCloseTo(121, 6);
    expect(p.npvEur).toBeCloseTo(210, 6);
  });
});

describe('TC-SOL-019 — recommendedKwp = argmax(npv) (óptimo interior)', () => {
  it('consumo=5 (1 h), eur=1, costPerKwp=10 ⇒ el óptimo es kwp=5', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 5, 1, 1.0)], // a kwpRef=1 produce 1; escala lineal con kwp
      kwpRef: 1, surplusCompensationEurPerKwh: 0, costPerKwp: 10,
      kwpMin: 1, kwpMax: 10, kwpStep: 1,
      financial: { horizonYears: 25, discountRatePct: 0, degradationPctPerYear: 0, priceEscalationPctPerYear: 0 },
    }));
    expect(r.recommendedKwp).toBe(5);
  });
});

describe('TC-SOL-020 — restricciones recortan el grid', () => {
  it('maxBudgetEur limita el kWp máximo evaluado', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 5, 1, 1.0)], kwpRef: 1, costPerKwp: 10,
      kwpMin: 1, kwpMax: 10, kwpStep: 1, maxBudgetEur: 30, // capex = kwp·10 ≤ 30 → kwp ≤ 3
      financial: { horizonYears: 25, discountRatePct: 0, degradationPctPerYear: 0, priceEscalationPctPerYear: 0 },
    }));
    expect(r.curve[r.curve.length - 1].kwp).toBe(3);
    expect(r.recommendedKwp).toBe(3); // npv crecía hasta 5, pero el presupuesto lo corta en 3
  });
  it('kwpMax acota el grid', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 5, 1, 1.0)], kwpRef: 1, costPerKwp: 10, kwpMin: 1, kwpMax: 4, kwpStep: 1,
    }));
    expect(r.curve.map(p => p.kwp)).toEqual([1, 2, 3, 4]);
  });
});

describe('TC-SOL-027 — la producción escala linealmente con kWp', () => {
  it('curva: producción a kwp=2 es el doble que a kwp=1', () => {
    const r = optimizeSizing(makeSizing({
      baseHours: [h(12, 1000, 1, 0.2)], // sin capping (consumo enorme)
      kwpRef: 1, kwpMin: 1, kwpMax: 2, kwpStep: 1,
    }));
    expect(r.curve[1].annualProductionKwh).toBeCloseTo(2 * r.curve[0].annualProductionKwh, 6);
  });
});
