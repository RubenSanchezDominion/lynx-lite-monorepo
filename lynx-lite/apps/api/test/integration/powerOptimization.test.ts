import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique', 'findMany'),
    contract: d('findFirst'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    iEERate: d('findFirst'),
    vATRate: d('findFirst'),
    meterRentalRate: d('findFirst'),
    reactiveEnergyRate: d('findMany'),
    excessPowerRate: d('findMany'),
    powerOptimization: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    powerOptimizationPeriod: d('deleteMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setOptimizationDataSource } from '../../src/services/runtime.js';
import type {
  PowerOptimizationDataSource,
  PowerOptimizationSeries,
} from '../../src/services/powerOptimizationData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };
const ADMIN_OTHER = { id: 'a2', role: 'ADMIN' as const, clientId: 'client-B' };

let seriesResult: PowerOptimizationSeries;
const dataSource: PowerOptimizationDataSource = { load: vi.fn(async () => seriesResult) };
setOptimizationDataSource(dataSource);

// Serie por defecto: 12 meses de histórico, datos utilizables. Aggregates mínimos válidos.
function defaultSeries(): PowerOptimizationSeries {
  return {
    granularity: 'hourly',
    powerSamplesByPeriod: { P1: [30], P2: [32], P3: [31], P4: [35], P5: [40], P6: [42] },
    monthlyP99ByPeriod: {},
    monthlyMaxByPeriod: { '2024-07': { P1: 45, P2: 45, P3: 45, P4: 45, P5: 45, P6: 45 } },
    overContractedRatioByPeriod: {},
    daysByMonth: { '2024-07': 30 },
    monthsWithData: 12,
    sampleCount: 6,
    hasUsableData: true,
  };
}

// Camino feliz 3.0TD MAXIMETRO: supply, contrato y maestros completos.
function setupHappyPath30TD() {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'DONE',
  });
  mockPrisma.contract.findFirst.mockResolvedValue({
    id: 'c1', supplyId: 's1', validFrom: new Date('2020-01-01'), validTo: null,
    contractedPowerP1: 50, contractedPowerP2: 50, contractedPowerP3: 50,
    contractedPowerP4: 50, contractedPowerP5: 50, contractedPowerP6: 50,
    modePowerControl: 'MAXIMETRO', hasSurplus: false, createdAt: new Date(),
  });
  const power = [1, 2, 3, 4, 5, 6].map(period => ({ period, rateType: 'POWER', eur: 0.08 }));
  const energy = [1, 2, 3, 4, 5, 6].map(period => ({ period, rateType: 'ENERGY', eur: 0.01 }));
  mockPrisma.tollRate.findMany.mockResolvedValue([...power, ...energy]);
  mockPrisma.chargeRate.findMany.mockResolvedValue([...power, ...energy]);
  mockPrisma.iEERate.findFirst.mockResolvedValue({ rate: 0.0511269632 });
  mockPrisma.vATRate.findFirst.mockResolvedValue({ rate: 0.21 });
  mockPrisma.meterRentalRate.findFirst.mockResolvedValue({ eurPerDay: 0.03966 });
  mockPrisma.reactiveEnergyRate.findMany.mockResolvedValue([]);
  mockPrisma.excessPowerRate.findMany.mockResolvedValue(
    [1, 2, 3, 4, 5, 6].map(period => ({ period, eurPerDay: 0.05 })),
  );
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.load as ReturnType<typeof vi.fn>).mockClear();
  seriesResult = defaultSeries();
});

const CALC = `query($i: PowerOptimizationInput!) {
  calculatePowerOptimization(input: $i) {
    granularity upliftFactor annualSaving recommendChange changeAllowed
    periods { period currentPower optimalPower diagnosis }
  }
}`;
const SAVE = `mutation($i: PowerOptimizationInput!) { savePowerOptimization(input: $i) { id annualSaving } }`;
const GET = `query($id: ID!) { powerOptimization(id: $id) { id annualSaving periods { period diagnosis } } }`;
const LIST = `query($s: String!, $l: Int, $o: Int) { powerOptimizations(supplyId: $s, limit: $l, offset: $o) { id analysisTo } }`;
const DEL = `mutation($id: ID!) { deletePowerOptimization(id: $id) }`;
const input = { cups: 'ES_CUPS', analysisFrom: '2024-01-01', analysisTo: '2024-12-31' };

// Registro persistido completo (incluye supply para assertSupplyAccess y periods).
function makePersisted(id: string, analysisTo = '2024-12-31') {
  return {
    id, supplyId: 's1', tariff: 'T_3_0TD',
    analysisFrom: new Date('2024-01-01'), analysisTo: new Date(analysisTo),
    granularity: 'hourly', upliftFactor: 1.05, sampleCount: 6,
    fixedSaving: 100, excessSaving: 0, annualSaving: 100, recommendChange: true,
    changeAllowed: true, changeBlockedUntil: null, createdAt: new Date(),
    supply: { id: 's1', clientId: 'client-A' },
    periods: [
      { period: 1, currentPower: 50, optimalPower: 40, p99Power: 38, observedMax: 39, diagnosis: 'OVERSIZED', marginPct: -20 },
    ],
  };
}

describe('M02 — calculatePowerOptimization (camino feliz)', () => {
  it('devuelve óptimos por período con uplift 1.05', async () => {
    setupHappyPath30TD();
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const data = r.data?.calculatePowerOptimization as { upliftFactor: number; periods: unknown[] };
    expect(data.upliftFactor).toBe(1.05);
    expect(data.periods).toHaveLength(6);
  });
});

describe('TC-OPT-010 — histórico insuficiente → INSUFFICIENT_HISTORY', () => {
  it('< 12 meses no invoca al engine', async () => {
    setupHappyPath30TD();
    seriesResult = { ...defaultSeries(), monthsWithData: 6 };
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('TC-OPT-011 — sin contrato vigente → CONTRACT_NOT_FOUND', () => {
  it('contrato ausente', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'DONE',
    });
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('CONTRACT_NOT_FOUND');
  });
});

describe('TC-OPT-012 — faltan maestros de potencia → REGULATORY_DATA_MISSING', () => {
  it('falta ExcessPowerRate con maxímetro', async () => {
    setupHappyPath30TD();
    mockPrisma.excessPowerRate.findMany.mockResolvedValue([]); // falta el término de exceso
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('REGULATORY_DATA_MISSING');
  });
});

describe('TC-OPT-013 — backfillStatus RUNNING → BACKFILL_RUNNING', () => {
  it('histórico aún no disponible', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'RUNNING',
    });
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_RUNNING');
  });
});

describe('TC-OPT-014 — savePowerOptimization idempotente', () => {
  it('dos llamadas con la misma clave devuelven el mismo registro', async () => {
    setupHappyPath30TD();
    // 1ª: no existe → create.
    mockPrisma.powerOptimization.findUnique.mockResolvedValueOnce(null);
    mockPrisma.powerOptimization.create.mockResolvedValue({
      id: 'opt-1', supplyId: 's1', tariff: 'T_3_0TD',
      analysisFrom: new Date('2024-01-01'), analysisTo: new Date('2024-12-31'),
      granularity: 'hourly', upliftFactor: 1.05, sampleCount: 6,
      fixedSaving: 0, excessSaving: 0, annualSaving: 0, recommendChange: false,
      changeAllowed: true, changeBlockedUntil: null, createdAt: new Date(), periods: [],
    });
    const r1 = await runOp(server, SAVE, { variables: { i: input }, user: DOMINION });
    expect(r1.errors).toBeUndefined();
    const id1 = (r1.data?.savePowerOptimization as { id: string }).id;

    // 2ª: ya existe → update sobre el mismo id.
    mockPrisma.powerOptimization.findUnique.mockResolvedValueOnce({ id: 'opt-1' });
    mockPrisma.powerOptimizationPeriod.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.powerOptimization.update.mockResolvedValue({
      id: 'opt-1', supplyId: 's1', tariff: 'T_3_0TD',
      analysisFrom: new Date('2024-01-01'), analysisTo: new Date('2024-12-31'),
      granularity: 'hourly', upliftFactor: 1.05, sampleCount: 6,
      fixedSaving: 0, excessSaving: 0, annualSaving: 0, recommendChange: false,
      changeAllowed: true, changeBlockedUntil: null, createdAt: new Date(), periods: [],
    });
    const r2 = await runOp(server, SAVE, { variables: { i: input }, user: DOMINION });
    const id2 = (r2.data?.savePowerOptimization as { id: string }).id;

    expect(id1).toBe('opt-1');
    expect(id2).toBe('opt-1');
    expect(mockPrisma.powerOptimization.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.powerOptimization.update).toHaveBeenCalledTimes(1);
  });
});

describe('TC-OPT-015 — CUPS inexistente → SUPPLY_NOT_FOUND', () => {
  it('supply ausente', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue(null);
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('SUPPLY_NOT_FOUND');
  });
});

describe('TC-OPT-016 — sin curva utilizable → NO_CONSUMPTION_DATA', () => {
  it('hasUsableData=false', async () => {
    setupHappyPath30TD();
    seriesResult = { ...defaultSeries(), hasUsableData: false };
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });
});

describe('TC-OPT-017 — backfill no listo → BACKFILL_PENDING / FAILED', () => {
  it('PENDING', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'PENDING',
    });
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_PENDING');
  });
  it('FAILED', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'FAILED',
    });
    const r = await runOp(server, CALC, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_FAILED');
  });
});

describe('TC-OPT-018 — autorización', () => {
  it('USUARIO no puede persistir (savePowerOptimization → FORBIDDEN)', async () => {
    setupHappyPath30TD(); // supply.clientId=client-A, id=s1; USUARIO_S1.supplyId=s1 pasa el acceso
    const r = await runOp(server, SAVE, { variables: { i: input }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.powerOptimization.create).not.toHaveBeenCalled();
  });

  it('ADMIN de otro cliente no accede al supply (calculate → FORBIDDEN)', async () => {
    setupHappyPath30TD(); // supply.clientId=client-A; ADMIN_OTHER.clientId=client-B
    const r = await runOp(server, CALC, { variables: { i: input }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('TC-OPT-019 — powerOptimization(id)', () => {
  it('recupera el registro con sus períodos', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(makePersisted('opt-1'));
    const r = await runOp(server, GET, { variables: { id: 'opt-1' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const o = r.data?.powerOptimization as { id: string; periods: unknown[] };
    expect(o.id).toBe('opt-1');
    expect(o.periods).toHaveLength(1);
  });

  it('id inexistente → null (sin error)', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(null);
    const r = await runOp(server, GET, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.powerOptimization).toBeNull();
  });

  it('ADMIN de otro cliente → FORBIDDEN', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(makePersisted('opt-1'));
    const r = await runOp(server, GET, { variables: { id: 'opt-1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('TC-OPT-020 — powerOptimizations(list)', () => {
  it('lista ordenada por analysisTo desc con paginación', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    mockPrisma.powerOptimization.findMany.mockResolvedValue([
      makePersisted('opt-2', '2024-12-31'),
      makePersisted('opt-1', '2023-12-31'),
    ]);
    const r = await runOp(server, LIST, { variables: { s: 's1', l: 10, o: 0 }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const list = r.data?.powerOptimizations as { id: string }[];
    expect(list.map(o => o.id)).toEqual(['opt-2', 'opt-1']);
    // El resolver delega la ordenación y la paginación a Prisma.
    expect(mockPrisma.powerOptimization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supplyId: 's1' },
        orderBy: { analysisTo: 'desc' },
        take: 10,
        skip: 0,
      }),
    );
  });

  it('supply inexistente → SUPPLY_NOT_FOUND', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue(null);
    const r = await runOp(server, LIST, { variables: { s: 'nope' }, user: DOMINION });
    expect(errorCode(r)).toBe('SUPPLY_NOT_FOUND');
  });
});

describe('TC-OPT-021 — deletePowerOptimization', () => {
  it('borra y devuelve true', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(makePersisted('opt-1'));
    mockPrisma.powerOptimizationPeriod.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.powerOptimization.delete.mockResolvedValue({});
    const r = await runOp(server, DEL, { variables: { id: 'opt-1' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.deletePowerOptimization).toBe(true);
    expect(mockPrisma.powerOptimization.delete).toHaveBeenCalled();
  });

  it('id inexistente → false (no borra)', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(null);
    const r = await runOp(server, DEL, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.data?.deletePowerOptimization).toBe(false);
    expect(mockPrisma.powerOptimization.delete).not.toHaveBeenCalled();
  });

  it('USUARIO → FORBIDDEN', async () => {
    mockPrisma.powerOptimization.findUnique.mockResolvedValue(makePersisted('opt-1'));
    const r = await runOp(server, DEL, { variables: { id: 'opt-1' }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.powerOptimization.delete).not.toHaveBeenCalled();
  });
});
