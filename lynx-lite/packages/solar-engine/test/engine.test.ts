import { describe, it, expect } from 'vitest';
import { simulateSolar } from '../src/index.js';
import type { SolarHour, SolarInput } from '../src/index.js';

function h(ts: string, consumptionKwh: number, productionKwh: number, eurPerKwh = 0.2): SolarHour {
  return { ts, month: ts.slice(0, 7), consumptionKwh, productionKwh, eurPerKwh };
}
function makeInput(over: Partial<SolarInput>): SolarInput {
  return { hours: [], surplusCompensationEurPerKwh: 0.05, capexEur: 0, ...over };
}

describe('TC-SOL-001 — autoconsumo = min(prod, consumo)', () => {
  it('prod=[2,5], consumo=[3,3] → autoconsumo=[2,3], excedente=[0,2]', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T10:00:00.000Z', 3, 2), h('2026-06-01T11:00:00.000Z', 3, 5)],
    }));
    expect(r.annualSelfConsumptionKwh).toBeCloseTo(5, 6); // 2 + 3
    expect(r.annualSurplusKwh).toBeCloseTo(2, 6); // 0 + 2
    expect(r.annualProductionKwh).toBeCloseTo(7, 6);
  });
});

describe('TC-SOL-002 — excedente = max(0, prod − consumo)', () => {
  it('producción nocturna 0 → sin autoconsumo ni excedente; prod > consumo → excedente', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T02:00:00.000Z', 4, 0), h('2026-06-01T13:00:00.000Z', 1, 6)],
    }));
    expect(r.annualSelfConsumptionKwh).toBeCloseTo(1, 6); // min(0,4)=0 + min(6,1)=1
    expect(r.annualSurplusKwh).toBeCloseTo(5, 6); // 0 + (6−1)
  });
});

describe('TC-SOL-003 — ratio de autoconsumo', () => {
  it('Σautoconsumo=5, Σproducción=10 → 0.5', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T10:00:00.000Z', 5, 5), h('2026-06-01T11:00:00.000Z', 0, 5)],
    }));
    expect(r.selfConsumptionRatio).toBeCloseTo(0.5, 4);
  });
});

describe('TC-SOL-004 — ratio de cobertura', () => {
  it('Σautoconsumo=5, Σconsumo=20 → 0.25', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T10:00:00.000Z', 5, 5), h('2026-06-01T20:00:00.000Z', 15, 0)],
    }));
    expect(r.coverageRatio).toBeCloseTo(0.25, 4);
  });
});

describe('TC-SOL-005 — ahorro = coste evitado + compensación', () => {
  it('autoconsumo 4 @0.20 + excedente 2 @0.05 → 0.9', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T13:00:00.000Z', 4, 6, 0.2)], // self=4, surplus=2
      surplusCompensationEurPerKwh: 0.05,
    }));
    expect(r.annualSavingEur).toBeCloseTo(0.9, 6); // 4·0.2 + 2·0.05
  });
});

describe('TC-SOL-006 — payback simple', () => {
  it('capex=10000, ahorro=2000 → 5 años', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T13:00:00.000Z', 10000, 10000, 0.2)], // self=10000, saving=2000
      surplusCompensationEurPerKwh: 0,
      capexEur: 10000,
    }));
    expect(r.annualSavingEur).toBeCloseTo(2000, 6);
    expect(r.paybackYears).toBeCloseTo(5, 6);
  });
});

describe('TC-SOL-007 — payback null si ahorro ≤ 0', () => {
  it('sin producción → ahorro 0 → payback null (sin división por cero)', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-06-01T02:00:00.000Z', 5, 0)],
      capexEur: 10000,
    }));
    expect(r.annualSavingEur).toBe(0);
    expect(r.paybackYears).toBeNull();
  });
});

describe('TC-SOL-008 — agregación mensual y orden', () => {
  it('dos meses → dos buckets ordenados por monthStart', () => {
    const r = simulateSolar(makeInput({
      hours: [h('2026-07-01T13:00:00.000Z', 2, 5), h('2026-06-01T13:00:00.000Z', 2, 5)],
    }));
    expect(r.months.map(m => m.key)).toEqual(['2026-06', '2026-07']);
    expect(r.months[0].productionKwh).toBeCloseTo(5, 6);
    expect(r.months[0].surplusKwh).toBeCloseTo(3, 6);
  });
});
