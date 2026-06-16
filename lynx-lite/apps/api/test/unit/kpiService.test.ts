import { describe, it, expect } from 'vitest';
import { madridLocal } from '../../src/services/kpiService.js';

// La conversión a hora local Madrid gobierna a qué día/semana/mes cae cada tramo. Es la única lógica
// sensible al cambio de hora (DST), así que se prueba explícitamente verano (CEST +2) e invierno (CET +1).
describe('madridLocal — hora de pared Europe/Madrid', () => {
  it('verano (CEST, +2): 2026-06-01T22:30Z → 2026-06-02 00:30 local (cruza de día)', () => {
    expect(madridLocal(new Date('2026-06-01T22:30:00.000Z'))).toBe('2026-06-02T00:30:00');
  });

  it('verano (CEST, +2): 2026-06-01T05:00Z → 07:00 local', () => {
    expect(madridLocal(new Date('2026-06-01T05:00:00.000Z'))).toBe('2026-06-01T07:00:00');
  });

  it('invierno (CET, +1): 2026-01-15T23:00Z → 2026-01-16 00:00 local', () => {
    expect(madridLocal(new Date('2026-01-15T23:00:00.000Z'))).toBe('2026-01-16T00:00:00');
  });

  it('invierno (CET, +1): 2026-01-15T06:00Z → 07:00 local', () => {
    expect(madridLocal(new Date('2026-01-15T06:00:00.000Z'))).toBe('2026-01-15T07:00:00');
  });
});
