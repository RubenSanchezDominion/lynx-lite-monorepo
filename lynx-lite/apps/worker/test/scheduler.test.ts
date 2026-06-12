import { describe, it, expect, vi } from 'vitest';
import type { WriteApi } from '@influxdata/influxdb-client';
import type { DatadisHttp } from '@lynx-lite/data-collector';
import { syncDailyConsumption } from '../src/scheduler.js';
import { runBackfill } from '../src/backfill.js';

function mockWriteApi() {
  return { writePoint: vi.fn(), flush: vi.fn(), close: vi.fn() } as unknown as WriteApi;
}

// http.get que responde por path: get-supplies → lista; resto → [].
function mockHttp(suppliesList: Array<{ cups: string; distributorCode: string }> = []) {
  const get = vi.fn(async (path: string) => {
    if (path.includes('get-supplies')) return suppliesList;
    return [];
  });
  return { http: { get } as DatadisHttp, get };
}

// ─── TC-PRE-026 — Job diario consulta InfluxDB antes de llamar a DATADIS ───────

describe('TC-PRE-026 — anti-429 en job diario', () => {
  it('Supply A (datos en Influx) no llama a DATADIS; Supply B (sin datos) sí, solo D-2', async () => {
    const now = new Date('2025-03-10T08:00:00Z'); // D-2 = 2025-03-08
    const { http, get } = mockHttp([
      { cups: 'CUPS_A', distributorCode: '2' },
      { cups: 'CUPS_B', distributorCode: '2' },
    ]);

    const prisma = {
      supply: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'a', cups: 'CUPS_A', tariff: 'T_2_0TD', backfillStatus: 'DONE' },
          { id: 'b', cups: 'CUPS_B', tariff: 'T_2_0TD', backfillStatus: 'DONE' },
        ]),
      },
    };

    // A ya tiene datos de D-2; B no.
    const consumptionExists = vi.fn(async (cups: string) => cups === 'CUPS_A');

    await syncDailyConsumption({
      prisma: prisma as never,
      http,
      writeApi: mockWriteApi(),
      consumptionExists,
      now,
    });

    const consumptionCalls = get.mock.calls.filter(([path]) =>
      String(path).includes('get-consumption-data'),
    );
    // Solo se pide consumo para B.
    expect(consumptionCalls).toHaveLength(1);

    // Y solo para el mes de D-2 (2025/03).
    const [, query] = consumptionCalls[0];
    expect((query as Record<string, string>).startDate).toBe('2025/03');
    expect((query as Record<string, string>).endDate).toBe('2025/03');
  });
});

// ─── TC-PRE-027 — Backfill de onboarding: scope correcto ──────────────────────

describe('TC-PRE-027 — scope del backfill por tarifa', () => {
  function setup(tariff: 'T_2_0TD' | 'T_3_0TD') {
    const { http, get } = mockHttp([{ cups: 'CUPS_X', distributorCode: '2' }]);
    const updates: Array<{ backfillStatus: string }> = [];
    const prisma = {
      supply: {
        findUnique: vi.fn().mockResolvedValue({ id: 'x', cups: 'CUPS_X', tariff, backfillStatus: 'PENDING' }),
        update: vi.fn(async ({ data }: { data: { backfillStatus: string } }) => {
          updates.push(data);
          return {};
        }),
      },
    };
    return { http, get, prisma, updates };
  }

  it('3.0TD: pide consumo + maxPower + reactiva, termina en DONE', async () => {
    const { http, get, prisma, updates } = setup('T_3_0TD');
    await runBackfill('x', { prisma: prisma as never, http, writeApi: mockWriteApi(), now: new Date('2025-06-15T00:00:00Z') });

    const paths = get.mock.calls.map(([p]) => String(p));
    expect(paths.some(p => p.includes('get-consumption-data'))).toBe(true);
    expect(paths.some(p => p.includes('get-max-power'))).toBe(true);
    expect(paths.some(p => p.includes('get-reactive-data-v2'))).toBe(true);
    expect(updates.map(u => u.backfillStatus)).toEqual(['RUNNING', 'DONE']);
  });

  it('2.0TD: pide consumo + maxPower, NO reactiva, termina en DONE', async () => {
    const { http, get, prisma, updates } = setup('T_2_0TD');
    await runBackfill('x', { prisma: prisma as never, http, writeApi: mockWriteApi(), now: new Date('2025-06-15T00:00:00Z') });

    const paths = get.mock.calls.map(([p]) => String(p));
    expect(paths.some(p => p.includes('get-consumption-data'))).toBe(true);
    expect(paths.some(p => p.includes('get-max-power'))).toBe(true);
    expect(paths.some(p => p.includes('get-reactive-data-v2'))).toBe(false);
    expect(updates.map(u => u.backfillStatus)).toEqual(['RUNNING', 'DONE']);
  });
});
