import { describe, it, expect, vi } from 'vitest';
import {
  consumptionToPoint,
  maxPowerToPoint,
  fetchConsumption,
  DatadisRateLimitError,
  type DatadisHttp,
} from '../src/datadis.js';
import { pvpcToPoint } from '../src/esios.js';
import { buildImputationPoints } from '../src/imputation.js';
import type { WriteApi } from '@influxdata/influxdb-client';

// WriteApi mínimo mockeado: solo necesitamos espiar writePoint.
function mockWriteApi() {
  return { writePoint: vi.fn() } as unknown as WriteApi & { writePoint: ReturnType<typeof vi.fn> };
}

// ─── TC-PRE-008 — Conversión de unidades desde DATADIS / ESIOS ────────────────

describe('TC-PRE-008 — conversión de unidades', () => {
  it('max_power: W → kW (48000 W → 48.0 kW), period 1 → P1', () => {
    const point = maxPowerToPoint({
      cups: 'ES0031000000000001JN',
      date: '2025/01/15',
      time: '10:00',
      maxPower: 48000,
      period: '1',
    });
    expect(point.measurement).toBe('max_power');
    expect(point.fields.kw).toBe(48.0);
    expect(point.tags.cups).toBe('ES0031000000000001JN');
    expect(point.tags.period).toBe('P1');
  });

  it('pvpc_price: €/MWh → €/kWh (180.5 → 0.1805), hora 09:00Z → Madrid 10:00 → P1', () => {
    const point = pvpcToPoint(
      { value: 180.5, datetime: '2025-01-15T09:00:00.000Z' },
      'T_2_0TD',
    );
    expect(point.measurement).toBe('pvpc_price');
    expect(point.fields.eur_kwh).toBeCloseTo(0.1805, 6);
    expect(point.tags.period).toBe('P1');
  });
});

// ─── TC-PRE-016 — DATADIS devuelve HTTP 429 ───────────────────────────────────

describe('TC-PRE-016 — HTTP 429 sin reintento ni escritura', () => {
  it('propaga DatadisRateLimitError y no escribe en InfluxDB', async () => {
    const writeApi = mockWriteApi();
    const http: DatadisHttp = {
      get: vi.fn().mockRejectedValue(new DatadisRateLimitError()),
    };

    await expect(
      fetchConsumption(
        http,
        { cups: 'ES0031000000000001JN', distributorCode: '2', startDate: '2025/01', endDate: '2025/01', tariff: 'T_2_0TD' },
        writeApi,
      ),
    ).rejects.toBeInstanceOf(DatadisRateLimitError);

    // Sin reintentos: una sola llamada HTTP.
    expect((http.get as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // Nada escrito.
    expect(writeApi.writePoint).not.toHaveBeenCalled();
  });
});

// ─── TC-PRE-017 — obtainMethod 'Estimada' → tags correctos ────────────────────

describe('TC-PRE-017 — estimada marca gap=true y estimated=true', () => {
  it('genera tags gap/estimated en true y conserva el kWh', () => {
    const point = consumptionToPoint(
      {
        cups: 'ES0031000000000001JN',
        date: '2025/01/15',
        time: '10:00',
        consumptionKWh: 2.5,
        obtainMethod: 'Estimada',
        surplusEnergyKWh: 0,
      },
      'T_2_0TD',
    );
    expect(point.measurement).toBe('hourly_consumption');
    expect(point.fields.kwh).toBe(2.5);
    expect(point.tags.gap).toBe('true');
    expect(point.tags.estimated).toBe('true');
    expect(point.tags.cups).toBe('ES0031000000000001JN');
    expect(point.tags.period).toBe('P1');
  });

  it('obtainMethod Real → gap=false y estimated=false', () => {
    const point = consumptionToPoint(
      {
        cups: 'ES0031000000000001JN',
        date: '2025/01/15',
        time: '10:00',
        consumptionKWh: 2.5,
        obtainMethod: 'Real',
        surplusEnergyKWh: 0,
      },
      'T_2_0TD',
    );
    expect(point.tags.gap).toBe('false');
    expect(point.tags.estimated).toBe('false');
  });
});

// ─── TC-PRE-018 — Imputación: timestamp ausente → valor de la semana anterior ──

describe('TC-PRE-018 - imputacion por perfil', () => {
  it('imputa la hora ausente con el valor del mismo slot 7 dias antes (gap=true, estimated=false)', async () => {
    // Ventana de 1 dia (24h) el 2025-01-15 UTC. Falta la hora 02:00Z (03:00 Madrid).
    const from = new Date('2025-01-15T00:00:00Z');
    const to = new Date('2025-01-16T00:00:00Z');

    // Todas presentes salvo 02:00Z.
    const present = new Set<string>();
    for (let h = 0; h < 24; h++) {
      if (h === 2) continue;
      present.add(new Date(Date.UTC(2025, 0, 15, h)).toISOString());
    }

    const missingIso = new Date('2025-01-15T02:00:00Z').toISOString();
    const prevWeekIso = new Date('2025-01-08T02:00:00Z').toISOString();

    const lookup = vi.fn(async (utc: Date) =>
      utc.toISOString() === prevWeekIso ? 1.234 : null,
    );

    const points = await buildImputationPoints({
      cups: 'ES0031000000000001JN', tariff: 'T_2_0TD', from, to, present, lookupPreviousWeek: lookup,
    });

    expect(points).toHaveLength(1);
    const imp = points[0];
    expect(imp.timestamp.toISOString()).toBe(missingIso);
    expect(imp.fields.kwh).toBe(1.234);
    expect(imp.tags.gap).toBe('true');
    expect(imp.tags.estimated).toBe('false');
    expect(imp.tags.cups).toBe('ES0031000000000001JN');
    // lookup consultado con la hora de la semana anterior.
    expect(lookup).toHaveBeenCalledWith(new Date(prevWeekIso));
  });

  it('no imputa si no hay valor de referencia la semana anterior', async () => {
    const from = new Date('2025-01-15T00:00:00Z');
    const to = new Date('2025-01-15T03:00:00Z'); // 3 horas
    const present = new Set<string>([
      new Date('2025-01-15T00:00:00Z').toISOString(),
      new Date('2025-01-15T01:00:00Z').toISOString(),
    ]);
    // Falta 02:00Z pero el lookup siempre devuelve null.
    const points = await buildImputationPoints({
      cups: 'C1', tariff: 'T_2_0TD', from, to, present, lookupPreviousWeek: async () => null,
    });
    expect(points).toHaveLength(0);
  });
});

// ─── Cobertura adicional: orquestación feliz escribe los puntos ───────────────

describe('fetchConsumption — camino feliz escribe en InfluxDB', () => {
  it('transforma y escribe cada registro', async () => {
    const writeApi = mockWriteApi();
    const http: DatadisHttp = {
      get: vi.fn().mockResolvedValue([
        { cups: 'C1', date: '2025/01/15', time: '10:00', consumptionKWh: 3, obtainMethod: 'Real', surplusEnergyKWh: 0 },
        { cups: 'C1', date: '2025/01/15', time: '11:00', consumptionKWh: 4, obtainMethod: 'Real', surplusEnergyKWh: 0 },
      ]),
    };
    const points = await fetchConsumption(
      http,
      { cups: 'C1', distributorCode: '2', startDate: '2025/01', endDate: '2025/01', tariff: 'T_2_0TD' },
      writeApi,
    );
    expect(points).toHaveLength(2);
    expect(writeApi.writePoint).toHaveBeenCalledTimes(2);
  });
});
