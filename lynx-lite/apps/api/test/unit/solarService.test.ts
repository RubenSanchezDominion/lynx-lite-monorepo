import { describe, it, expect } from 'vitest';
import { hourWeightsForMonth, hourlyProductionKwh } from '../../src/services/solarService.js';

// TC-SOL-009 — reparto E_m → horas (perfil solar). Pura, determinista.

describe('TC-SOL-009 — pesos horarios del perfil solar', () => {
  const lat = 41.65; // Zaragoza
  it('suman 1, 0 de noche, máximo a mediodía (junio)', () => {
    const w = hourWeightsForMonth(5, lat); // junio
    expect(w).toHaveLength(24);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(w[2]).toBe(0); // 02:00 noche
    expect(w[23]).toBe(0); // 23:00 noche
    const maxHour = w.indexOf(Math.max(...w));
    expect(maxHour).toBeGreaterThanOrEqual(11);
    expect(maxHour).toBeLessThanOrEqual(13); // pico ~mediodía
  });

  it('invierno tiene menos horas de luz que verano', () => {
    const winter = hourWeightsForMonth(11, lat).filter(x => x > 0).length; // diciembre
    const summer = hourWeightsForMonth(5, lat).filter(x => x > 0).length; // junio
    expect(summer).toBeGreaterThan(winter);
  });
});

describe('TC-SOL-009 — conservación de energía en el reparto', () => {
  it('Σ producción de un mes completo = E_m', () => {
    const lat = 41.65;
    const monthly = new Array(12).fill(0);
    monthly[5] = 6000; // E_m junio
    const weights = Array.from({ length: 12 }, (_, m) => hourWeightsForMonth(m, lat));
    // Σ sobre las 24 h de un día × 30 días de junio.
    let perDay = 0;
    for (let h = 0; h < 24; h++) perDay += hourlyProductionKwh('2025-06', h, monthly, weights);
    expect(perDay * 30).toBeCloseTo(6000, 3); // junio tiene 30 días
  });
});
