import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique'),
    solarSimulation: d('findUnique', 'create', 'findMany'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setSolarDataSource } from '../../src/services/runtime.js';
import type { SolarDataSource, RawSolarHour } from '../../src/services/solarData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };
const ADMIN_OTHER = { id: 'a2', role: 'ADMIN' as const, clientId: 'client-B' };

let consumption: RawSolarHour[];
const dataSource: SolarDataSource = {
  loadConsumption: vi.fn(async () => consumption),
  fetchProduction: vi.fn(async () => ({ monthly: new Array(12).fill(500), annual: 6000 })),
};
setSolarDataSource(dataSource);

// Horas de mediodía en junio (producción solar > 0) con PVPC conocido.
function defaultConsumption(): RawSolarHour[] {
  return [
    { ts: '2025-06-15T10:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
    { ts: '2025-06-15T11:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
    { ts: '2025-06-15T12:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
  ];
}

function setupSupply(over: Record<string, unknown> = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE', ...over,
  });
}
function setupRates() {
  mockPrisma.tollRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.02 })));
  mockPrisma.chargeRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.01 })));
}
function makeSim(over: Record<string, unknown> = {}) {
  return {
    id: 'sim1', supplyId: 's1', lat: 41.65, lon: -0.88, kwp: 10, lossPct: 14, tilt: 35, azimuth: 0, costPerKwp: 1000,
    rangeStart: new Date('2025-06-15T10:00:00.000Z'), rangeEnd: new Date('2025-06-15T13:00:00.000Z'),
    annualProductionKwh: 6000, monthlyProductionJson: JSON.stringify([
      { key: '2025-06', monthStart: '2025-06-15T10:00:00.000Z', productionKwh: 30, selfConsumptionKwh: 30, surplusKwh: 0 },
    ]),
    annualSelfConsumptionKwh: 30, annualSurplusKwh: 0, selfConsumptionRatio: 1, coverageRatio: 0.5,
    annualSavingEur: 3.9, paybackYears: 2564.1, computedAt: new Date(),
    ...over,
  };
}

const input = { cups: 'ES_CUPS', lat: 41.65, lon: -0.88, kwp: 10 };

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.loadConsumption as ReturnType<typeof vi.fn>).mockClear();
  (dataSource.fetchProduction as ReturnType<typeof vi.fn>).mockClear();
  (dataSource.fetchProduction as ReturnType<typeof vi.fn>).mockResolvedValue({ monthly: new Array(12).fill(500), annual: 6000 });
  consumption = defaultConsumption();
});

const SIMULATE = `mutation($i: SimulateSolarInput!) { simulateSolar(input: $i) { id annualProductionKwh selfConsumptionRatio paybackYears months { monthKey productionKwh } } }`;
const GET = `query($id: ID!) { solarSimulation(id: $id) { id } }`;
const LIST = `query($s: String!) { solarSimulations(supplyId: $s) { id } }`;

describe('TC-SOL-010 — simulateSolar calcula y persiste', () => {
  it('params + producción + curva → SolarSimulation persistida', async () => {
    setupSupply();
    setupRates();
    mockPrisma.solarSimulation.findUnique.mockResolvedValue(null);
    mockPrisma.solarSimulation.create.mockResolvedValue(makeSim());
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.solarSimulation.create).toHaveBeenCalledTimes(1);
    expect((r.data?.simulateSolar as { id: string }).id).toBe('sim1');
  });
  it('sin curva → NO_CONSUMPTION_DATA', async () => {
    setupSupply();
    setupRates();
    mockPrisma.solarSimulation.findUnique.mockResolvedValue(null);
    consumption = [];
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });
});

describe('TC-SOL-011 — caché por parámetros (idempotente, sin re-llamar PVGIS)', () => {
  it('segunda llamada con mismos parámetros devuelve la caché', async () => {
    setupSupply();
    setupRates();
    mockPrisma.solarSimulation.findUnique.mockResolvedValueOnce(null); // 1ª: no hay caché
    mockPrisma.solarSimulation.create.mockResolvedValue(makeSim());
    const r1 = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(r1.errors).toBeUndefined();

    setupSupply();
    mockPrisma.solarSimulation.findUnique.mockResolvedValueOnce(makeSim()); // 2ª: caché
    const r2 = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(r2.errors).toBeUndefined();

    expect(mockPrisma.solarSimulation.create).toHaveBeenCalledTimes(1); // no recrea
    expect(dataSource.fetchProduction).toHaveBeenCalledTimes(1); // no re-llama PVGIS
  });
});

describe('TC-SOL-012 — parámetros inválidos → SOLAR_INVALID_PARAMS', () => {
  it('lat fuera de rango / kwp ≤ 0 / lossPct fuera de [0,100]', async () => {
    setupSupply();
    const bad = [
      { ...input, lat: 120 },
      { ...input, kwp: 0 },
      { ...input, lossPct: 150 },
    ];
    for (const i of bad) {
      const r = await runOp(server, SIMULATE, { variables: { i }, user: DOMINION });
      expect(errorCode(r)).toBe('SOLAR_INVALID_PARAMS');
    }
    expect(dataSource.fetchProduction).not.toHaveBeenCalled();
    expect(mockPrisma.solarSimulation.create).not.toHaveBeenCalled();
  });
});

describe('TC-SOL-013 — PVGIS caído sin caché → PVGIS_UNAVAILABLE', () => {
  it('fetchProduction lanza y no hay caché', async () => {
    setupSupply();
    mockPrisma.solarSimulation.findUnique.mockResolvedValue(null);
    (dataSource.fetchProduction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('PVGIS 503'));
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('PVGIS_UNAVAILABLE');
  });
});

describe('TC-SOL-014 — reutiliza la composición de precio de M01', () => {
  it('sin maestros de energía → REGULATORY_DATA_MISSING', async () => {
    setupSupply();
    mockPrisma.solarSimulation.findUnique.mockResolvedValue(null);
    mockPrisma.tollRate.findMany.mockResolvedValue([]); // faltan peajes de energía
    mockPrisma.chargeRate.findMany.mockResolvedValue([]);
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('REGULATORY_DATA_MISSING');
  });
});

describe('TC-SOL-015 — backfill no listo → BACKFILL_*', () => {
  it('RUNNING → BACKFILL_RUNNING', async () => {
    setupSupply({ backfillStatus: 'RUNNING' });
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_RUNNING');
  });
});

describe('TC-SOL-016 — consultas y autorización', () => {
  it('solarSimulation(id) inexistente → null (sin error)', async () => {
    mockPrisma.solarSimulation.findUnique.mockResolvedValue(null);
    const r = await runOp(server, GET, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.solarSimulation).toBeNull();
  });
  it('USUARIO no puede simular (→ FORBIDDEN)', async () => {
    setupSupply();
    const r = await runOp(server, SIMULATE, { variables: { i: input }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.solarSimulation.create).not.toHaveBeenCalled();
  });
  it('ADMIN de otro cliente no lista simulaciones ajenas (→ FORBIDDEN)', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    const r = await runOp(server, LIST, { variables: { s: 's1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});
