import { describe, it, expect } from 'vitest';
import { buildProductionMap, productionForUtcHour } from '../../src/services/solarService.js';
import type { PvProductionSeries } from '@lynx-lite/data-collector';

// TC-SOL-009 (M06 v2) — alineado de la serie de año tipo (seriescalc) a la curva del cliente por
// posición de calendario (mes, día, hora) UTC. Reemplaza al reparto por campana de v1. Pura.

function series(rows: Array<[number, number, number, number]>): PvProductionSeries {
  const hourly = rows.map(([month, day, hour, kwh]) => ({ month, day, hour, kwh }));
  return { hourly, annual: hourly.reduce((a, h) => a + h.kwh, 0) };
}

describe('TC-SOL-009 — alineado serie año-tipo → curva del cliente', () => {
  it('cruza por (mes, día, hora) UTC; 0 si no hay dato para esa hora', () => {
    const map = buildProductionMap(series([[6, 15, 12, 4.2], [6, 15, 13, 3.1]]));
    expect(productionForUtcHour(map, new Date('2025-06-15T12:00:00.000Z'))).toBeCloseTo(4.2, 6);
    expect(productionForUtcHour(map, new Date('2025-06-15T13:00:00.000Z'))).toBeCloseTo(3.1, 6);
    expect(productionForUtcHour(map, new Date('2025-06-15T02:00:00.000Z'))).toBe(0); // noche, sin dato
  });

  it('29-feb reutiliza 28-feb (el año tipo no tiene bisiesto)', () => {
    const map = buildProductionMap(series([[2, 28, 10, 1.5]]));
    expect(productionForUtcHour(map, new Date('2024-02-29T10:00:00.000Z'))).toBeCloseTo(1.5, 6);
  });
});
