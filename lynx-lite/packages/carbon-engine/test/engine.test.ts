import { describe, it, expect } from 'vitest';
import { computeCarbonFootprint, mean } from '../src/index.js';
import type { CarbonInput, ConsumptionHour, Co2FactorHour } from '../src/index.js';

// Hora de consumo. Mes local por defecto = "YYYY-MM" del ts (suficiente para los tests).
function ch(ts: string, kwh: number, over: Partial<ConsumptionHour> = {}): ConsumptionHour {
  return { ts, month: ts.slice(0, 7), kwh, gap: false, ...over };
}
function ff(ts: string, gPerKwh: number): Co2FactorHour {
  return { ts, gPerKwh };
}
function makeInput(over: Partial<CarbonInput>): CarbonInput {
  return { consumption: [], factors: [], ...over };
}

describe('estadística', () => {
  it('mean (vacío y normal)', () => {
    expect(mean([])).toBe(0);
    expect(mean([200, 400])).toBe(300);
  });
});

describe('TC-CO2-003 — emisiones por hora (g→kg)', () => {
  it('kwh=100, factor=300 gCO₂/kWh → 30 kgCO₂', () => {
    const ts = '2026-01-01T10:00:00.000Z';
    const r = computeCarbonFootprint(makeInput({ consumption: [ch(ts, 100)], factors: [ff(ts, 300)] }));
    expect(r.totalCo2Kg).toBeCloseTo(30, 6);
    expect(r.months[0].co2Kg).toBeCloseTo(30, 6);
  });
});

describe('TC-CO2-004 — agregación mensual suma kWh y CO₂', () => {
  it('dos horas del mismo mes', () => {
    const a = '2026-01-01T10:00:00.000Z';
    const b = '2026-01-02T11:00:00.000Z';
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(a, 10), ch(b, 20)], factors: [ff(a, 200), ff(b, 200)] }),
    );
    expect(r.months).toHaveLength(1);
    expect(r.months[0].kwh).toBeCloseTo(30, 6);
    expect(r.months[0].co2Kg).toBeCloseTo((10 * 200 + 20 * 200) / 1000, 6);
  });
});

describe('TC-CO2-005 — factorAvg mensual ponderado por consumo', () => {
  it('(kwh=10,f=200) y (kwh=90,f=400) → 380 (no media simple 300)', () => {
    const a = '2026-01-01T10:00:00.000Z';
    const b = '2026-01-01T11:00:00.000Z';
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(a, 10), ch(b, 90)], factors: [ff(a, 200), ff(b, 400)] }),
    );
    expect(r.months[0].factorAvg).toBeCloseTo(380, 6);
  });
});

describe('TC-CO2-006 — factor propio vs media nacional', () => {
  it('consumo en horas limpias → ownFactor < nacional → deltaPct < 0', () => {
    const clean = '2026-01-01T13:00:00.000Z'; // factor bajo (solar)
    const dirty = '2026-01-01T20:00:00.000Z'; // factor alto (punta)
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(clean, 90), ch(dirty, 10)], factors: [ff(clean, 100), ff(dirty, 500)] }),
    );
    expect(r.nationalAvgFactorGPerKwh).toBeCloseTo(300, 6); // media simple (100+500)/2
    expect(r.ownFactorGPerKwh).toBeCloseTo(140, 6); // (90·100+10·500)/100
    expect(r.deltaPct).toBeLessThan(0);
  });
});

describe('TC-CO2-007 — deltaPct exacto', () => {
  it('own=240, nacional=300 → deltaPct = −0.20', () => {
    const a = '2026-01-01T10:00:00.000Z';
    const b = '2026-01-01T11:00:00.000Z';
    // kwh=[80,20], factor=[200,400] → own=240; nacional=300.
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(a, 80), ch(b, 20)], factors: [ff(a, 200), ff(b, 400)] }),
    );
    expect(r.ownFactorGPerKwh).toBeCloseTo(240, 6);
    expect(r.nationalAvgFactorGPerKwh).toBeCloseTo(300, 6);
    expect(r.deltaPct).toBeCloseTo(-0.2, 6);
  });
});

describe('TC-CO2-008 — frontera de mes/año y orden de evolución', () => {
  it('diciembre y enero → claves correctas y ordenadas', () => {
    const dec = '2025-12-31T10:00:00.000Z';
    const jan = '2026-01-01T10:00:00.000Z';
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(jan, 10), ch(dec, 10)], factors: [ff(jan, 200), ff(dec, 200)] }),
    );
    expect(r.months.map(m => m.key)).toEqual(['2025-12', '2026-01']);
  });
});

describe('TC-CO2-009 — gap propaga hasGaps (no aborta)', () => {
  it('hora con gap → hasGaps true en mes y resultado', () => {
    const a = '2026-01-01T10:00:00.000Z';
    const b = '2026-01-01T11:00:00.000Z';
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(a, 10, { gap: true }), ch(b, 10)], factors: [ff(a, 200), ff(b, 200)] }),
    );
    expect(r.hasGaps).toBe(true);
    expect(r.months[0].hasGaps).toBe(true);
    expect(r.totalKwh).toBeCloseTo(20, 6); // sigue calculando
  });
  it('hora sin factor se excluye de totales', () => {
    const a = '2026-01-01T10:00:00.000Z';
    const b = '2026-01-01T11:00:00.000Z';
    const r = computeCarbonFootprint(
      makeInput({ consumption: [ch(a, 10), ch(b, 999)], factors: [ff(a, 200)] }), // b sin factor
    );
    expect(r.totalKwh).toBeCloseTo(10, 6);
    expect(r.nationalAvgFactorGPerKwh).toBeCloseTo(200, 6);
  });
});

describe('TC-CO2-010 — totales', () => {
  it('totalKwh y totalCo2Kg sobre todo el periodo', () => {
    const hours = ['2026-01-01T10:00:00.000Z', '2026-02-01T10:00:00.000Z'];
    const r = computeCarbonFootprint(
      makeInput({
        consumption: hours.map(ts => ch(ts, 50)),
        factors: hours.map(ts => ff(ts, 400)),
      }),
    );
    expect(r.totalKwh).toBeCloseTo(100, 6);
    expect(r.totalCo2Kg).toBeCloseTo((100 * 400) / 1000, 6); // 40 kg
    expect(r.months).toHaveLength(2);
  });
});
