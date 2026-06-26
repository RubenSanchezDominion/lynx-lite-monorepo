import { describe, it, expect } from 'vitest';
import { comparePerformance, alignExpectedToMeasured, type CanonicalPoint } from '../src/index.js';

function pts(...pairs: [string, number][]): CanonicalPoint[] {
  return pairs.map(([ts, kwh]) => ({ ts, kwh }));
}

describe('TC-INV-011 — comparePerformance PR y kWh/kWp', () => {
  it('medido=850, esperado=1000, kwp=10 → PR=0.85 (umbral inclusive), kWh/kWp=85', () => {
    const measured = pts(['2026-06-01T10:00:00.000Z', 850]);
    const expected = pts(['2026-06-01T10:00:00.000Z', 1000]);
    const r = comparePerformance({ measured, expected, kwp: 10, underperformanceThreshold: 0.85 });
    expect(r.performanceRatio).toBeCloseTo(0.85, 6);
    expect(r.specificYieldKwhPerKwp).toBeCloseTo(85, 6);
    expect(r.underperforming).toBe(false); // 0.85 NO es < 0.85
  });
});

describe('TC-INV-012 — comparePerformance detecta infraproducción', () => {
  it('PR=0.70 < 0.85 → underperforming, pct=30, mes peor identificado', () => {
    const measured = pts(
      ['2026-06-01T10:00:00.000Z', 70],
      ['2026-07-01T10:00:00.000Z', 90],
    );
    const expected = pts(
      ['2026-06-01T10:00:00.000Z', 100],
      ['2026-07-01T10:00:00.000Z', 100],
    );
    const r = comparePerformance({ measured, expected, kwp: 1 });
    expect(r.performanceRatio).toBeCloseTo(0.8, 6);
    expect(r.underperforming).toBe(true);
    const worst = [...r.months].sort((a, b) => a.ratio - b.ratio)[0];
    expect(worst.key).toBe('2026-06'); // junio rinde 0.70, peor que julio 0.90
    expect(worst.ratio).toBeCloseTo(0.7, 6);
  });

  it('underperformancePct refleja la caída', () => {
    const r = comparePerformance({
      measured: pts(['2026-06-01T10:00:00.000Z', 70]),
      expected: pts(['2026-06-01T10:00:00.000Z', 100]),
      kwp: 1,
    });
    expect(r.underperformancePct).toBeCloseTo(30, 6);
  });
});

describe('comparePerformance — horas sin baseline no entran al ratio', () => {
  it('una hora medida sin expected correspondiente se ignora', () => {
    const measured = pts(['2026-06-01T10:00:00.000Z', 50], ['2026-06-01T11:00:00.000Z', 999]);
    const expected = pts(['2026-06-01T10:00:00.000Z', 100]); // sin las 11:00
    const r = comparePerformance({ measured, expected, kwp: 1 });
    expect(r.measuredKwh).toBeCloseTo(50, 6);
    expect(r.expectedKwh).toBeCloseTo(100, 6);
    expect(r.performanceRatio).toBeCloseTo(0.5, 6);
  });
});

describe('alignExpectedToMeasured — alinea año tipo por (mes,día,hora) UTC', () => {
  it('mapea por posición de calendario; 29-feb reutiliza 28-feb', () => {
    const measured = pts(['2024-02-29T10:00:00.000Z', 5]); // año bisiesto
    const typical = new Map<string, number>([['2-28-10', 7]]); // clave mes-día-hora
    const aligned = alignExpectedToMeasured(measured, typical);
    expect(aligned).toHaveLength(1);
    expect(aligned[0].ts).toBe('2024-02-29T10:00:00.000Z');
    expect(aligned[0].kwh).toBe(7);
  });
});
