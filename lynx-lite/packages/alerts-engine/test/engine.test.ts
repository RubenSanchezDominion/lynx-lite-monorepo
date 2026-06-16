import { describe, it, expect } from 'vitest';
import { detectAlerts, mean, sampleStd } from '../src/index.js';
import type { AlertDetectionInput, AlertInterval, DetectedAlert } from '../src/index.js';

// Día base: 2025-06-09 (lunes). Construye un intervalo a la hora local indicada.
const TS = (hour: number) => `2025-06-09T${String(hour).padStart(2, '0')}:00:00.000Z`;
function iv(over: Partial<AlertInterval>): AlertInterval {
  return {
    ts: TS(over.localHour ?? 12),
    localHour: 12,
    weekday: 1,
    period: 1,
    kwh: 10,
    estimated: false,
    gap: false,
    ...over,
  };
}

function makeInput(over: Partial<AlertDetectionInput>): AlertDetectionInput {
  return {
    targetDay: [],
    referenceBySlot: {},
    contractedPower: {},
    intervalHours: 1,
    config: {
      enabledTypes: ['ZSCORE', 'PHANTOM', 'LIMIT', 'ESTIMATED'],
      sensitivity: 'EQUILIBRADO',
      limitThresholdPct: 0.95,
      phantomThresholdKwh: 1,
      inactivityWindows: [],
    },
    ...over,
  };
}

const byType = (alerts: DetectedAlert[], t: string) => alerts.filter(a => a.type === t);

describe('estadística', () => {
  it('mean y sampleStd (n−1)', () => {
    expect(mean([9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 11, 11, 10])).toBeCloseTo(10, 6);
    expect(sampleStd([9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 11, 11, 10])).toBeCloseTo(1, 6);
    expect(sampleStd([10])).toBe(0);
    expect(sampleStd([10, 10, 10])).toBe(0);
  });
});

describe('TC-ALT-001 — ZSCORE dispara con z ≥ umbral (equilibrado)', () => {
  it('z ≈ 4.24 → alerta WARNING', () => {
    const ref = [10, 10, 11, 9, 10, 10, 11, 9, 10, 10, 11, 9, 10]; // μ=10, σ≈0.707
    const r = detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['ZSCORE'] },
        targetDay: [iv({ localHour: 9, weekday: 1, kwh: 13 })],
        referenceBySlot: { '1-9': ref },
      }),
    );
    const z = byType(r, 'ZSCORE');
    expect(z).toHaveLength(1);
    expect(z[0].deviation!).toBeCloseTo(4.243, 2);
    expect(z[0].severity).toBe('WARNING'); // |z| < 3.0 + 1.5
    expect(z[0].expectedValue!).toBeCloseTo(10, 6);
  });
});

describe('TC-ALT-002 — la sensibilidad cambia el umbral', () => {
  // ref: μ=10, σ=1 exacta; kwh=12.8 → z=2.8.
  const ref = [9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 11, 11, 10];
  const run = (sensitivity: 'CONSERVADOR' | 'EQUILIBRADO' | 'AGRESIVO') =>
    detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['ZSCORE'], sensitivity },
        targetDay: [iv({ localHour: 9, weekday: 1, kwh: 12.8 })],
        referenceBySlot: { '1-9': ref },
      }),
    );
  it('agresivo (2.5) dispara; equilibrado (3.0) y conservador (3.5) no', () => {
    expect(byType(run('AGRESIVO'), 'ZSCORE')).toHaveLength(1);
    expect(byType(run('EQUILIBRADO'), 'ZSCORE')).toHaveLength(0);
    expect(byType(run('CONSERVADOR'), 'ZSCORE')).toHaveLength(0);
  });
});

describe('TC-ALT-003 — σ = 0 no produce falso positivo', () => {
  it('referencia constante → sin alerta y sin división por cero', () => {
    const ref = Array(13).fill(10);
    const r = detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['ZSCORE'] },
        targetDay: [iv({ localHour: 9, weekday: 1, kwh: 25 })],
        referenceBySlot: { '1-9': ref },
      }),
    );
    expect(byType(r, 'ZSCORE')).toHaveLength(0);
  });
});

describe('TC-ALT-004 — PHANTOM en franja de inactividad (cruza medianoche)', () => {
  it('03:00 dentro de 22:00→06:00 con kwh > umbral → alerta', () => {
    const r = detectAlerts(
      makeInput({
        config: {
          ...makeInput({}).config,
          enabledTypes: ['PHANTOM'],
          inactivityWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }],
        },
        targetDay: [iv({ localHour: 3, weekday: 1, kwh: 4 })],
      }),
    );
    const p = byType(r, 'PHANTOM');
    expect(p).toHaveLength(1);
    expect(p[0].severity).toBe('WARNING');
    expect(p[0].deviation!).toBeCloseTo(3, 6); // 4 − 1
  });
});

describe('TC-ALT-005 — consumo en franja activa no genera PHANTOM', () => {
  it('12:00 fuera de la franja inactiva → sin alerta', () => {
    const r = detectAlerts(
      makeInput({
        config: {
          ...makeInput({}).config,
          enabledTypes: ['PHANTOM'],
          inactivityWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }],
        },
        targetDay: [iv({ localHour: 12, weekday: 1, kwh: 4 })],
      }),
    );
    expect(byType(r, 'PHANTOM')).toHaveLength(0);
  });
});

describe('TC-ALT-006 — LIMIT al alcanzar 95 % de la potencia', () => {
  const run = (kwh: number) =>
    detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['LIMIT'] },
        contractedPower: { P1: 10 },
        targetDay: [iv({ localHour: 12, period: 1, kwh })],
      }),
    );
  it('9.6 kW → WARNING; 10.2 kW → CRITICAL; 9.0 kW → nada', () => {
    const a = byType(run(9.6), 'LIMIT');
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe('WARNING');
    const b = byType(run(10.2), 'LIMIT');
    expect(b[0].severity).toBe('CRITICAL');
    expect(byType(run(9.0), 'LIMIT')).toHaveLength(0);
  });
});

describe('TC-ALT-007 — LIMIT en 15 min deriva ×4', () => {
  it('intervalHours 0.25, kwh 2.5 → kw 10', () => {
    const r = detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['LIMIT'] },
        intervalHours: 0.25,
        contractedPower: { P1: 10 },
        targetDay: [iv({ localHour: 12, period: 1, kwh: 2.5 })],
      }),
    );
    const a = byType(r, 'LIMIT');
    expect(a).toHaveLength(1);
    expect(a[0].observedValue).toBeCloseTo(10, 6);
    expect(a[0].severity).toBe('CRITICAL');
  });
});

describe('TC-ALT-008 — ESTIMATED marca intervalos estimados', () => {
  it('estimated=true → INFO; estimated=false → nada', () => {
    const yes = detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['ESTIMATED'] },
        targetDay: [iv({ localHour: 15, estimated: true, gap: true, kwh: 5 })],
      }),
    );
    const e = byType(yes, 'ESTIMATED');
    expect(e).toHaveLength(1);
    expect(e[0].severity).toBe('INFO');
    expect(e[0].expectedValue).toBeNull();

    const no = detectAlerts(
      makeInput({
        config: { ...makeInput({}).config, enabledTypes: ['ESTIMATED'] },
        targetDay: [iv({ localHour: 15, estimated: false, kwh: 5 })],
      }),
    );
    expect(byType(no, 'ESTIMATED')).toHaveLength(0);
  });
});

describe('TC-ALT-009 — enabledTypes desactiva tipos', () => {
  it('solo LIMIT activo: el resto de señales no generan alertas', () => {
    const r = detectAlerts(
      makeInput({
        config: {
          ...makeInput({}).config,
          enabledTypes: ['LIMIT'],
          inactivityWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '06:00' }],
        },
        contractedPower: { P1: 10 },
        referenceBySlot: { '1-3': Array(13).fill(1) },
        targetDay: [
          iv({ localHour: 3, weekday: 1, period: 1, kwh: 9.8, estimated: true, gap: false }),
        ],
      }),
    );
    // El intervalo dispararía ZSCORE, PHANTOM y (gap=false) sobre el límite, pero solo LIMIT está activo.
    expect(new Set(r.map(a => a.type))).toEqual(new Set(['LIMIT']));
  });
});
