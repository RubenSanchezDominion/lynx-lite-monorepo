import { describe, it, expect } from 'vitest';
import {
  aggregateConsumptionAndPvpc,
  type HourlyConsumptionRow,
  type HourlyPriceRow,
} from '../../src/services/pvpcWeighting.js';

describe('aggregateConsumptionAndPvpc — ponderación PVPC por energía', () => {
  it('pondera el precio por el consumo de cada hora, por período', () => {
    // P1: 2 horas — 10 kWh a 0.20 €, 30 kWh a 0.10 €.
    // Media simple = 0.15; media ponderada = (10*0.20 + 30*0.10)/40 = 5/40 = 0.125.
    const consumption: HourlyConsumptionRow[] = [
      { period: 'P1', time: '2025-01-15T09:00:00Z', kwh: 10 },
      { period: 'P1', time: '2025-01-15T10:00:00Z', kwh: 30 },
    ];
    const prices: HourlyPriceRow[] = [
      { time: '2025-01-15T09:00:00Z', eurKwh: 0.2 },
      { time: '2025-01-15T10:00:00Z', eurKwh: 0.1 },
    ];

    const { consumptionByPeriod, pvpcByPeriod } = aggregateConsumptionAndPvpc(consumption, prices);
    expect(consumptionByPeriod.P1).toBe(40);
    expect(pvpcByPeriod.P1).toBeCloseTo(0.125, 6);
  });

  it('separa correctamente por período', () => {
    const consumption: HourlyConsumptionRow[] = [
      { period: 'P1', time: 't1', kwh: 100 },
      { period: 'P2', time: 't2', kwh: 50 },
    ];
    const prices: HourlyPriceRow[] = [
      { time: 't1', eurKwh: 0.3 },
      { time: 't2', eurKwh: 0.05 },
    ];
    const { consumptionByPeriod, pvpcByPeriod } = aggregateConsumptionAndPvpc(consumption, prices);
    expect(consumptionByPeriod).toEqual({ P1: 100, P2: 50 });
    expect(pvpcByPeriod.P1).toBeCloseTo(0.3, 6);
    expect(pvpcByPeriod.P2).toBeCloseTo(0.05, 6);
  });

  it('hora de consumo 0 no rompe la ponderación (respaldo: media simple)', () => {
    const consumption: HourlyConsumptionRow[] = [
      { period: 'P3', time: 'tA', kwh: 0 },
      { period: 'P3', time: 'tB', kwh: 0 },
    ];
    const prices: HourlyPriceRow[] = [
      { time: 'tA', eurKwh: 0.08 },
      { time: 'tB', eurKwh: 0.12 },
    ];
    const { consumptionByPeriod, pvpcByPeriod } = aggregateConsumptionAndPvpc(consumption, prices);
    expect(consumptionByPeriod.P3).toBe(0);
    // den = 0 → respaldo media simple = 0.10.
    expect(pvpcByPeriod.P3).toBeCloseTo(0.1, 6);
  });

  it('hora sin precio disponible no se pondera (pero sí suma consumo)', () => {
    const consumption: HourlyConsumptionRow[] = [
      { period: 'P1', time: 't1', kwh: 10 },
      { period: 'P1', time: 't2', kwh: 10 }, // sin precio
    ];
    const prices: HourlyPriceRow[] = [{ time: 't1', eurKwh: 0.2 }];
    const { consumptionByPeriod, pvpcByPeriod } = aggregateConsumptionAndPvpc(consumption, prices);
    expect(consumptionByPeriod.P1).toBe(20); // suma todo el consumo
    expect(pvpcByPeriod.P1).toBeCloseTo(0.2, 6); // pondera solo la hora con precio
  });
});
