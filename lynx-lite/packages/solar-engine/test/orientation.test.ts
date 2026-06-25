import { describe, it, expect } from 'vitest';
import { optimizeOrientation } from '../src/index.js';
import type { SolarHour, SolarOrientationInput } from '../src/index.js';

// Tres horas (10,12,14) de un día de junio. Construye `hours` con consumo y producción dados.
function candidate(label: string, azimuth: number, consumption: number[], production: number[]) {
  const hours: SolarHour[] = [10, 12, 14].map((hr, i) => ({
    ts: `2025-06-15T${String(hr).padStart(2, '0')}:00:00.000Z`,
    month: '2025-06',
    consumptionKwh: consumption[i],
    productionKwh: production[i],
    eurPerKwh: 0.2,
  }));
  return { candidate: { tilt: 30, azimuth, label }, hours };
}

function makeInput(over: Partial<SolarOrientationInput>): SolarOrientationInput {
  return { perCandidate: [], surplusCompensationEurPerKwh: 0, capexEur: 0, ...over };
}

describe('TC-SOL-023 — Sur gana con consumo centrado al mediodía', () => {
  it('producción Sur (pico mediodía) casa con consumo mediodía → mayor VAN', () => {
    const cons = [2, 6, 2]; // pico a las 12
    const r = optimizeOrientation(makeInput({
      perCandidate: [
        candidate('S', 0, cons, [2, 6, 2]), // self = 2+6+2 = 10
        candidate('E', -90, cons, [6, 2, 2]), // self = 2+2+2 = 6
        candidate('O', 90, cons, [2, 2, 6]), // self = 2+2+2 = 6
      ],
    }));
    expect(r.recommended.label).toBe('S');
    expect(r.recommended.annualSelfConsumptionKwh).toBeCloseTo(10, 6);
  });
});

describe('TC-SOL-026 — recommended = argmax(npv)', () => {
  it('gana el candidato con mayor ahorro (mayor autoconsumo)', () => {
    const r = optimizeOrientation(makeInput({
      perCandidate: [
        candidate('A', 0, [5, 5, 5], [1, 1, 1]), // self = 3
        candidate('B', 45, [5, 5, 5], [5, 5, 5]), // self = 15
      ],
      capexEur: 100,
      financial: { horizonYears: 25, discountRatePct: 0, degradationPctPerYear: 0, priceEscalationPctPerYear: 0 },
    }));
    expect(r.recommended.label).toBe('B');
    expect(r.recommended.npvEur).toBeGreaterThan(r.candidates.find(c => c.label === 'A')!.npvEur);
  });
});
