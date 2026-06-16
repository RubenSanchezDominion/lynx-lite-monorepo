import { describe, it, expect } from 'vitest';
import { computeKpi, median } from '../src/index.js';
import type { ConsumptionHour, KpiInput, ProductionInterval } from '../src/index.js';

// Bucket de consumo horario (eurPerKwh ya compuesto). Día base 2026-06-01.
function ch(hourUtc: number, kwh: number, eurPerKwh: number, over: Partial<ConsumptionHour> = {}): ConsumptionHour {
  return {
    ts: `2026-06-01T${String(hourUtc).padStart(2, '0')}:00:00.000Z`,
    hours: 1,
    kwh,
    eurPerKwh,
    gap: false,
    ...over,
  };
}

// Tramo de producción. `localStart` por defecto = inicio UTC sin Z (suficiente para los tests).
function pi(over: Partial<ProductionInterval> & Pick<ProductionInterval, 'startTs' | 'endTs' | 'units'>): ProductionInterval {
  return {
    localStart: over.startTs.replace('Z', '').replace('.000', ''),
    ...over,
  };
}

function makeInput(over: Partial<KpiInput>): KpiInput {
  return { production: [], consumption: [], granularity: 'DAY', outlierPct: 0.2, ...over };
}

describe('estadística', () => {
  it('median (par e impar)', () => {
    expect(median([0.1, 0.11, 0.09, 0.5])).toBeCloseTo(0.105, 6);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

describe('TC-KPI-001 — imputación de tramo alineado a horas', () => {
  it('06:00–10:00 sobre 4 buckets de 10 kWh a 0.20 €/kWh → 40 kWh, 8 €, 0.10 €/ud', () => {
    const r = computeKpi(
      makeInput({
        consumption: [ch(6, 10, 0.2), ch(7, 10, 0.2), ch(8, 10, 0.2), ch(9, 10, 0.2)],
        production: [pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T10:00:00.000Z', units: 80 })],
      }),
    );
    expect(r.intervals[0].kwh).toBeCloseTo(40, 6);
    expect(r.intervals[0].costEur).toBeCloseTo(8, 6);
    expect(r.intervals[0].eurPerUnit).toBeCloseTo(0.1, 6);
  });
});

describe('TC-KPI-002 — imputación con bordes a mitad de hora', () => {
  it('06:30–08:30 → 0.5·10 + 1·10 + 0.5·10 = 20 kWh', () => {
    const r = computeKpi(
      makeInput({
        consumption: [ch(6, 10, 0.2), ch(7, 10, 0.2), ch(8, 10, 0.2)],
        production: [pi({ startTs: '2026-06-01T06:30:00.000Z', endTs: '2026-06-01T08:30:00.000Z', units: 100 })],
      }),
    );
    expect(r.intervals[0].kwh).toBeCloseTo(20, 6);
    expect(r.intervals[0].costEur).toBeCloseTo(4, 6);
  });
});

describe('TC-KPI-003 — cuarto-horario (hours=0.25)', () => {
  it('la duración del bucket gobierna la fracción, no la hora fija', () => {
    const q = (min: number, kwh: number): ConsumptionHour => ({
      ts: `2026-06-01T06:${String(min).padStart(2, '0')}:00.000Z`,
      hours: 0.25,
      kwh,
      eurPerKwh: 0.2,
      gap: false,
    });
    const r = computeKpi(
      makeInput({
        consumption: [q(0, 2.5), q(15, 2.5), q(30, 2.5), q(45, 2.5)],
        // Tramo cubre solo los dos primeros cuartos (06:00–06:30).
        production: [pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T06:30:00.000Z', units: 10 })],
      }),
    );
    expect(r.intervals[0].kwh).toBeCloseTo(5, 6);
  });
});

describe('TC-KPI-004 — coste = Σ kWh · eurPerKwh por bucket (no promedia el precio)', () => {
  it('precio distinto por hora', () => {
    const r = computeKpi(
      makeInput({
        consumption: [ch(6, 10, 0.1), ch(7, 10, 0.3)],
        production: [pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T08:00:00.000Z', units: 100 })],
      }),
    );
    expect(r.intervals[0].costEur).toBeCloseTo(10 * 0.1 + 10 * 0.3, 6); // 4.0
  });
});

describe('TC-KPI-005 — €/unidad por tramo', () => {
  it('costEur / units', () => {
    const r = computeKpi(
      makeInput({
        consumption: [ch(6, 60, 0.2)],
        production: [pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T07:00:00.000Z', units: 240 })],
      }),
    );
    expect(r.intervals[0].costEur).toBeCloseTo(12, 6);
    expect(r.intervals[0].eurPerUnit).toBeCloseTo(0.05, 6);
  });
});

describe('TC-KPI-006 — agregación DAY suma coste y unidades (divide al final)', () => {
  it('costEur=[30,10]/units=[40,60] → 40/100 = 0.40 (≠ media de 0.75 y 0.167)', () => {
    const r = computeKpi(
      makeInput({
        granularity: 'DAY',
        consumption: [ch(6, 30, 1.0), ch(7, 10, 1.0)], // 6:00 da 30 kWh, 7:00 da 10 kWh
        production: [
          pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T07:00:00.000Z', units: 40 }), // 30 €
          pi({ startTs: '2026-06-01T07:00:00.000Z', endTs: '2026-06-01T08:00:00.000Z', units: 60 }), // 10 €
        ],
      }),
    );
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0].costEur).toBeCloseTo(40, 6);
    expect(r.buckets[0].units).toBeCloseTo(100, 6);
    expect(r.buckets[0].eurPerUnit).toBeCloseTo(0.4, 6);
  });
});

describe('TC-KPI-007 — agregación SHIFT y "sin turno"', () => {
  it('M/T/N → tres buckets; sin shift → #SIN', () => {
    const c = [ch(6, 10, 0.2), ch(14, 10, 0.2), ch(22, 10, 0.2), ch(2, 10, 0.2)];
    const r = computeKpi(
      makeInput({
        granularity: 'SHIFT',
        consumption: c,
        production: [
          pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T07:00:00.000Z', units: 10, shift: 'M', localStart: '2026-06-01T06:00:00' }),
          pi({ startTs: '2026-06-01T14:00:00.000Z', endTs: '2026-06-01T15:00:00.000Z', units: 10, shift: 'T', localStart: '2026-06-01T14:00:00' }),
          pi({ startTs: '2026-06-01T22:00:00.000Z', endTs: '2026-06-01T23:00:00.000Z', units: 10, shift: 'N', localStart: '2026-06-01T22:00:00' }),
          pi({ startTs: '2026-06-01T02:00:00.000Z', endTs: '2026-06-01T03:00:00.000Z', units: 10, localStart: '2026-06-01T02:00:00' }),
        ],
      }),
    );
    const keys = new Set(r.buckets.map(b => b.key));
    expect(keys).toEqual(new Set(['2026-06-01#M', '2026-06-01#T', '2026-06-01#N', '2026-06-01#SIN']));
  });
});

describe('TC-KPI-008 — agregación WEEK (ISO) y MONTH', () => {
  it('claves YYYY-Www / YYYY-MM correctas (incluida frontera de año)', () => {
    const cons = [ch(6, 10, 0.2)];
    const mkProd = (localStart: string): ProductionInterval => ({
      startTs: '2026-06-01T06:00:00.000Z',
      endTs: '2026-06-01T07:00:00.000Z',
      localStart,
      units: 10,
    });
    // 2025-12-31 (miércoles) pertenece a la semana ISO 2026-W01.
    const week = computeKpi(makeInput({ granularity: 'WEEK', consumption: cons, production: [mkProd('2025-12-31T06:00:00')] }));
    expect(week.buckets[0].key).toBe('2026-W01');
    const month = computeKpi(makeInput({ granularity: 'MONTH', consumption: cons, production: [mkProd('2026-03-15T06:00:00')] }));
    expect(month.buckets[0].key).toBe('2026-03');
  });
});

describe('TC-KPI-009 — baseline = mediana de buckets', () => {
  it('mediana robusta, no media', () => {
    // 4 días: 3 normales (~0.10) y uno atípico (0.50). Mediana ≈ 0.105.
    const prod: ProductionInterval[] = [];
    const cons: ConsumptionHour[] = [];
    const days = [
      { d: '01', units: 100 }, // 0.10
      { d: '02', units: 91 }, // ≈0.1099
      { d: '03', units: 110 }, // ≈0.0909
      { d: '04', units: 20 }, // 0.50
    ];
    for (const { d, units } of days) {
      cons.push({ ts: `2026-06-${d}T06:00:00.000Z`, hours: 1, kwh: 50, eurPerKwh: 0.2, gap: false }); // 10 €
      prod.push({ startTs: `2026-06-${d}T06:00:00.000Z`, endTs: `2026-06-${d}T07:00:00.000Z`, localStart: `2026-06-${d}T06:00:00`, units });
    }
    const r = computeKpi(makeInput({ granularity: 'DAY', consumption: cons, production: prod }));
    expect(r.baselineEurPerUnit).toBeCloseTo(median(r.buckets.map(b => b.eurPerUnit)), 9);
    expect(r.baselineEurPerUnit).toBeCloseTo(0.105, 3);
  });
});

describe('TC-KPI-010 — outlier ±20 % sobre baseline', () => {
  it('marca por encima y por debajo del ±20 %', () => {
    // baseline = 0.10. Buckets: 0.10, 0.13 (>0.12 → outlier), 0.11 (no), 0.07 (<0.08 → outlier).
    const days = [
      { d: '01', kwh: 50, units: 100 }, // 0.10
      { d: '02', kwh: 65, units: 100 }, // 0.13
      { d: '03', kwh: 55, units: 100 }, // 0.11
      { d: '04', kwh: 35, units: 100 }, // 0.07
    ];
    const cons: ConsumptionHour[] = [];
    const prod: ProductionInterval[] = [];
    for (const { d, kwh, units } of days) {
      cons.push({ ts: `2026-06-${d}T06:00:00.000Z`, hours: 1, kwh, eurPerKwh: 0.2, gap: false });
      prod.push({ startTs: `2026-06-${d}T06:00:00.000Z`, endTs: `2026-06-${d}T07:00:00.000Z`, localStart: `2026-06-${d}T06:00:00`, units });
    }
    const r = computeKpi(makeInput({ granularity: 'DAY', consumption: cons, production: prod, outlierPct: 0.2 }));
    const by = Object.fromEntries(r.buckets.map(b => [b.key, b.isOutlier]));
    expect(by['2026-06-01']).toBe(false);
    expect(by['2026-06-02']).toBe(true);
    expect(by['2026-06-03']).toBe(false);
    expect(by['2026-06-04']).toBe(true);
  });
});

describe('TC-KPI-011 — tramo con gap marca hasGap (no aborta)', () => {
  it('hasGap por tramo y hasGaps global', () => {
    const r = computeKpi(
      makeInput({
        consumption: [ch(6, 10, 0.2, { gap: true }), ch(7, 10, 0.2)],
        production: [pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T08:00:00.000Z', units: 100 })],
      }),
    );
    expect(r.intervals[0].hasGap).toBe(true);
    expect(r.hasGaps).toBe(true);
    expect(r.intervals[0].kwh).toBeCloseTo(20, 6); // sigue calculando
  });
});

describe('TC-KPI-012 — totales y orden de evolución', () => {
  it('totales correctos; buckets ordenados por bucketStart', () => {
    const cons = [ch(6, 10, 0.2)];
    const r = computeKpi(
      makeInput({
        granularity: 'DAY',
        consumption: [
          { ts: '2026-06-02T06:00:00.000Z', hours: 1, kwh: 10, eurPerKwh: 0.2, gap: false },
          { ts: '2026-06-01T06:00:00.000Z', hours: 1, kwh: 10, eurPerKwh: 0.2, gap: false },
        ],
        production: [
          pi({ startTs: '2026-06-02T06:00:00.000Z', endTs: '2026-06-02T07:00:00.000Z', units: 100, localStart: '2026-06-02T06:00:00' }),
          pi({ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T07:00:00.000Z', units: 100, localStart: '2026-06-01T06:00:00' }),
        ],
      }),
    );
    void cons;
    expect(r.totalKwh).toBeCloseTo(20, 6);
    expect(r.totalCostEur).toBeCloseTo(4, 6);
    expect(r.avgEurPerUnit).toBeCloseTo(0.02, 6);
    expect(r.buckets.map(b => b.key)).toEqual(['2026-06-01', '2026-06-02']);
  });
});
