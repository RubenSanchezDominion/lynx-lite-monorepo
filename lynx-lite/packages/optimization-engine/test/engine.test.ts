import { describe, it, expect } from 'vitest';
import { optimizePower, percentile } from '../src/index.js';
import type { OptimizationInput } from '../src/index.js';

// Construye un OptimizationInput con defaults inocuos; cada test sobreescribe lo relevante.
function makeInput(over: Partial<OptimizationInput>): OptimizationInput {
  return {
    tariff: 'T_3_0TD',
    granularity: 'hourly',
    contractedPower: {},
    powerSamplesByPeriod: {},
    monthlyP99ByPeriod: {},
    monthlyMaxByPeriod: {},
    daysByMonth: {},
    modePowerControl: 'ICP',
    overContractedRatioByPeriod: {},
    tollRatesPower: {},
    chargeRatesPower: {},
    excessRatesPower: {},
    lastPowerChangeDate: null,
    analysisTo: '2025-12-31',
    ...over,
  };
}

// Samples cuyo p99 (R-7) es exactamente `v`: un único valor → percentil devuelve ese valor.
const exact = (v: number) => [v];

describe('percentile (R-7 / numpy linear)', () => {
  it('interpola linealmente', () => {
    // rank = 0.99·3 = 2.97 → v[2] + 0.97·(v[3]−v[2]) = 30 + 0.97·10 = 39.7
    expect(percentile([10, 20, 30, 40], 99)).toBeCloseTo(39.7, 6);
  });
  it('un solo valor → ese valor', () => {
    expect(percentile([42], 99)).toBe(42);
  });
  it('vacío → 0', () => {
    expect(percentile([], 99)).toBe(0);
  });
});

describe('TC-OPT-001 — percentil 99 + uplift + monotonía (3.0TD, hourly)', () => {
  it('aplica uplift 1.05 y eleva P3 por monotonía', () => {
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 40, P2: 40, P3: 40, P4: 40, P5: 40, P6: 40 },
        powerSamplesByPeriod: {
          P1: exact(30),
          P2: exact(32),
          P3: exact(31),
          P4: exact(35),
          P5: exact(40),
          P6: exact(42),
        },
      }),
    );
    expect(r.upliftFactor).toBe(1.05);
    const opt = Object.fromEntries(r.periods.map(p => [p.period, p.optimalPower]));
    expect(opt[1]).toBeCloseTo(31.5, 6);
    expect(opt[2]).toBeCloseTo(33.6, 6);
    expect(opt[3]).toBeCloseTo(33.6, 6); // elevado por P2 (raw 32.55)
    expect(opt[4]).toBeCloseTo(36.75, 6);
    expect(opt[5]).toBeCloseTo(42.0, 6);
    expect(opt[6]).toBeCloseTo(44.1, 6);
  });
});

describe('TC-OPT-002 — 2.0TD con 2 períodos de potencia', () => {
  it('solo calcula P1 y P2 y respeta P1 ≤ P2', () => {
    const r = optimizePower(
      makeInput({
        tariff: 'T_2_0TD',
        contractedPower: { P1: 10, P2: 10 },
        powerSamplesByPeriod: { P1: exact(8), P2: exact(5) },
      }),
    );
    expect(r.periods).toHaveLength(2);
    const opt = Object.fromEntries(r.periods.map(p => [p.period, p.optimalPower]));
    expect(opt[1]).toBeCloseTo(8.4, 6); // 8 × 1.05
    expect(opt[2]).toBeCloseTo(8.4, 6); // raw 5.25 elevado a 8.4 por monotonía
    expect(opt[2]).toBeGreaterThanOrEqual(opt[1]);
  });
});

describe('TC-OPT-003 — granularidad 15 min → sin uplift', () => {
  it('upliftFactor 1.00 y optimalRaw = p99', () => {
    const r = optimizePower(
      makeInput({
        granularity: 'quarter',
        contractedPower: { P1: 40, P2: 40, P3: 40, P4: 40, P5: 40, P6: 40 },
        powerSamplesByPeriod: {
          P1: exact(30),
          P2: exact(32),
          P3: exact(31),
          P4: exact(35),
          P5: exact(40),
          P6: exact(42),
        },
      }),
    );
    expect(r.upliftFactor).toBe(1.0);
    const opt = Object.fromEntries(r.periods.map(p => [p.period, p.optimalPower]));
    expect(opt[1]).toBeCloseTo(30, 6);
    expect(opt[2]).toBeCloseTo(32, 6);
    expect(opt[3]).toBeCloseTo(32, 6); // raw 31 elevado a 32 por P2
    expect(opt[6]).toBeCloseTo(42, 6);
  });
});

describe('TC-OPT-004 — sobredimensionamiento (6 meses consecutivos)', () => {
  const sixMonths = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
  it('6 meses con p99 < 0.70×Pc → OVERSIZED', () => {
    const monthlyP99ByPeriod = Object.fromEntries(sixMonths.map(m => [m, { P1: 30 }])); // < 35
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 50 },
        powerSamplesByPeriod: { P1: exact(30) },
        monthlyP99ByPeriod,
      }),
    );
    expect(r.periods[0].diagnosis).toBe('OVERSIZED');
  });
  it('solo 5 meses consecutivos → OK', () => {
    const monthlyP99ByPeriod = Object.fromEntries(sixMonths.map(m => [m, { P1: 30 }]));
    monthlyP99ByPeriod['2025-03'] = { P1: 45 }; // rompe la racha (≥ 35)
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 50 },
        powerSamplesByPeriod: { P1: exact(30) },
        monthlyP99ByPeriod,
      }),
    );
    expect(r.periods[0].diagnosis).toBe('OK');
  });
});

describe('TC-OPT-005 — infradimensionamiento (>2% intervalos en exceso)', () => {
  it('un mes con ratio 0.03 → UNDERSIZED', () => {
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 30 },
        powerSamplesByPeriod: { P1: exact(28) },
        overContractedRatioByPeriod: { '2025-07': { P1: 0.03 } },
      }),
    );
    expect(r.periods[0].diagnosis).toBe('UNDERSIZED');
  });
  it('UNDERSIZED gana a OVERSIZED si ambos se cumplen', () => {
    const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 50 },
        powerSamplesByPeriod: { P1: exact(30) },
        monthlyP99ByPeriod: Object.fromEntries(months.map(m => [m, { P1: 30 }])), // oversize
        overContractedRatioByPeriod: { '2025-03': { P1: 0.05 } }, // undersize
      }),
    );
    expect(r.periods[0].diagnosis).toBe('UNDERSIZED');
  });
});

describe('TC-OPT-006 — ahorro por término de potencia (computePowerTerm real)', () => {
  it('fixedSaving = 538.74 €/año', () => {
    const toll = { P1: 0.08, P2: 0.08, P3: 0.08, P4: 0.08, P5: 0.08, P6: 0.08 };
    const r = optimizePower(
      makeInput({
        contractedPower: { P1: 40, P2: 40, P3: 40, P4: 40, P5: 40, P6: 40 },
        powerSamplesByPeriod: {
          P1: exact(30),
          P2: exact(32),
          P3: exact(31),
          P4: exact(35),
          P5: exact(40),
          P6: exact(42),
        },
        tollRatesPower: toll,
      }),
    );
    // optimalPower = {31.5, 33.6, 33.6, 36.75, 42, 44.1}; Σ = 221.55
    expect(r.fixedSaving).toBeCloseTo(538.74, 2);
    expect(r.excessSaving).toBe(0); // ICP → sin excesos
    expect(r.annualSaving).toBeCloseTo(538.74, 2);
  });
});

describe('TC-OPT-007 — ahorro incluye excesos evitados (tipos 4/5)', () => {
  it('excessSaving = 22.50 € (Σ tepp×(Pdp−Pcp)×n, sin √ ni ×2)', () => {
    const r = optimizePower(
      makeInput({
        modePowerControl: 'MAXIMETRO',
        contractedPower: { P1: 30 },
        powerSamplesByPeriod: { P1: exact(45) }, // optimal = 45 × 1.05 = 47.25 (sin excesos)
        monthlyMaxByPeriod: { '2025-07': { P1: 45 } },
        daysByMonth: { '2025-07': 30 },
        excessRatesPower: { P1: 0.05 },
      }),
    );
    // excessCost(current 30) = 0.05 × (45−30) × 30 = 22.5 ; excessCost(optimal 47.25) = 0
    expect(r.excessSaving).toBeCloseTo(22.5, 6);
    expect(r.annualSaving).toBeCloseTo(r.fixedSaving + r.excessSaving, 6);
  });
});

describe('TC-OPT-007b — 2.0TD con ICP → término de excesos = 0', () => {
  it('excessSaving 0 aunque Pdp > Pc', () => {
    const r = optimizePower(
      makeInput({
        tariff: 'T_2_0TD',
        modePowerControl: 'ICP',
        contractedPower: { P1: 10, P2: 10 },
        powerSamplesByPeriod: { P1: exact(8), P2: exact(6) },
        monthlyMaxByPeriod: { '2025-07': { P1: 99, P2: 99 } },
        daysByMonth: { '2025-07': 30 },
        excessRatesPower: { P1: 0.05, P2: 0.05 },
      }),
    );
    expect(r.excessSaving).toBe(0);
  });
});

describe('TC-OPT-008 — annualSaving negativo → recommendChange false', () => {
  it('bajar potencia dispara excesos y el ahorro es negativo', () => {
    const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
    const r = optimizePower(
      makeInput({
        modePowerControl: 'MAXIMETRO',
        contractedPower: { P1: 50 },
        powerSamplesByPeriod: { P1: exact(10) }, // optimal = 10.5 → mucho exceso
        monthlyP99ByPeriod: Object.fromEntries(months.map(m => [m, { P1: 10 }])), // oversize
        monthlyMaxByPeriod: Object.fromEntries(months.map(m => [m, { P1: 48 }])),
        daysByMonth: Object.fromEntries(months.map(m => [m, 30])),
        excessRatesPower: { P1: 0.05 },
        tollRatesPower: { P1: 0 }, // sin ahorro fijo
      }),
    );
    expect(r.periods[0].diagnosis).toBe('OVERSIZED'); // hay desvío
    expect(r.annualSaving).toBeLessThan(0);
    expect(r.recommendChange).toBe(false);
  });
});

describe('TC-OPT-009 — restricción de un cambio/año', () => {
  const DAY = 86_400_000;
  const analysisTo = '2025-12-31';
  const minus = (days: number) =>
    new Date(new Date(analysisTo).getTime() - days * DAY).toISOString().slice(0, 10);

  it('cambio hace 200 días → bloqueado', () => {
    const last = minus(200);
    const r = optimizePower(
      makeInput({ contractedPower: { P1: 10 }, lastPowerChangeDate: last, analysisTo }),
    );
    expect(r.changeAllowed).toBe(false);
    const expected = new Date(new Date(last).getTime() + 365 * DAY).toISOString().slice(0, 10);
    expect(r.changeBlockedUntil).toBe(expected);
  });

  it('cambio hace 400 días → permitido', () => {
    const r = optimizePower(
      makeInput({ contractedPower: { P1: 10 }, lastPowerChangeDate: minus(400), analysisTo }),
    );
    expect(r.changeAllowed).toBe(true);
    expect(r.changeBlockedUntil).toBeNull();
  });
});
