import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    user: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    supply: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    contract: d('findFirst'),
    preInvoice: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    preInvoiceLine: d('deleteMany'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    iEERate: d('findFirst'),
    vATRate: d('findFirst'),
    meterRentalRate: d('findFirst'),
    reactiveEnergyRate: d('findMany'),
    excessPowerRate: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setDataSource } from '../../src/services/runtime.js';
import type { PreInvoiceDataSource, PreInvoiceTimeSeries } from '../../src/services/preInvoiceData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };

// DataSource configurable por test.
let tsResult: PreInvoiceTimeSeries;
let reactiveResult: Record<string, number> | null;
const dataSource: PreInvoiceDataSource = {
  load: vi.fn(async () => tsResult),
  loadReactiveByPeriod: vi.fn(async () => reactiveResult),
};
setDataSource(dataSource);

// Series temporales por defecto (con datos facturables).
function defaultTs(): PreInvoiceTimeSeries {
  return {
    consumptionByPeriod: { P1: 500, P2: 800, P3: 1200 },
    maxPowerByPeriod: {},
    pvpcByPeriod: { P1: 0.14, P2: 0.1, P3: 0.06 },
    gapHoursByPeriod: {},
    totalGapHours: 0,
    hasBillableData: true,
  };
}

// Configura los mocks del camino feliz 2.0TD.
function setupHappyPath2_0TD(overrides: { supply?: object } = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE',
    ...overrides.supply,
  });
  mockPrisma.contract.findFirst.mockResolvedValue({
    id: 'c1', supplyId: 's1', validFrom: new Date('2020-01-01'), validTo: null,
    contractedPowerP1: 10, contractedPowerP2: 10, contractedPowerP3: null,
    contractedPowerP4: null, contractedPowerP5: null, contractedPowerP6: null,
    modePowerControl: 'ICP', hasSurplus: false, createdAt: new Date(),
  });
  mockPrisma.tollRate.findMany.mockResolvedValue([
    { period: 1, rateType: 'POWER', eur: 0.115327 }, { period: 2, rateType: 'POWER', eur: 0.002572 },
    { period: 1, rateType: 'ENERGY', eur: 0.007215 }, { period: 2, rateType: 'ENERGY', eur: 0.00486 }, { period: 3, rateType: 'ENERGY', eur: 0.000841 },
  ]);
  mockPrisma.chargeRate.findMany.mockResolvedValue([
    { period: 1, rateType: 'POWER', eur: 0.011 }, { period: 2, rateType: 'POWER', eur: 0.001 },
    { period: 1, rateType: 'ENERGY', eur: 0.003 }, { period: 2, rateType: 'ENERGY', eur: 0.002 }, { period: 3, rateType: 'ENERGY', eur: 0.001 },
  ]);
  mockPrisma.iEERate.findFirst.mockResolvedValue({ rate: 0.0511269632 });
  mockPrisma.vATRate.findFirst.mockResolvedValue({ rate: 0.21 });
  mockPrisma.meterRentalRate.findFirst.mockResolvedValue({ eurPerDay: 0.026114 });
  mockPrisma.reactiveEnergyRate.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  // Limpia los registros de llamada del datasource (mantiene su implementación).
  (dataSource.load as ReturnType<typeof vi.fn>).mockClear();
  (dataSource.loadReactiveByPeriod as ReturnType<typeof vi.fn>).mockClear();
  tsResult = defaultTs();
  reactiveResult = null;
});

const CALC = `query($i: PreInvoiceInput!) { calculatePreInvoice(input: $i) { total reactiveEnergy gapHoursCount gapPeriodsJson } }`;
const SAVE = `mutation($i: PreInvoiceInput!) { savePreInvoice(input: $i) { id reactiveEnergy } }`;
const period = { cups: 'ES_CUPS', periodFrom: '2025-01-01', periodTo: '2025-01-31' };

// TC-PRE-006 - CUPS inexistente
describe('TC-PRE-006 - CUPS inexistente', () => {
  it('eleva SUPPLY_NOT_FOUND', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue(null);
    const res = await runOp(server, CALC, { variables: { i: { ...period, cups: 'NOPE' } }, user: DOMINION });
    expect(errorCode(res)).toBe('SUPPLY_NOT_FOUND');
  });
});

// TC-PRE-005 - Periodo sin datos de consumo
describe('TC-PRE-005 - sin datos de consumo', () => {
  it('eleva NO_CONSUMPTION_DATA', async () => {
    setupHappyPath2_0TD();
    tsResult = { ...defaultTs(), consumptionByPeriod: {}, hasBillableData: false };
    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(errorCode(res)).toBe('NO_CONSUMPTION_DATA');
  });
});

// TC-PRE-024 - Sin contrato vigente
describe('TC-PRE-024 - sin contrato vigente', () => {
  it('eleva CONTRACT_NOT_FOUND', async () => {
    setupHappyPath2_0TD();
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(errorCode(res)).toBe('CONTRACT_NOT_FOUND');
  });
});

// TC-PRE-025 - Falta maestro regulatorio
describe('TC-PRE-025 - falta maestro regulatorio', () => {
  it('eleva REGULATORY_DATA_MISSING', async () => {
    setupHappyPath2_0TD();
    mockPrisma.iEERate.findFirst.mockResolvedValue(null);
    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(errorCode(res)).toBe('REGULATORY_DATA_MISSING');
  });
});

// TC-PRE-007 - Persistencia idempotente
describe('TC-PRE-007 - savePreInvoice idempotente', () => {
  it('si ya existe (supplyId, from, to) actualiza y devuelve el mismo id', async () => {
    setupHappyPath2_0TD();
    const existing = { id: 'pi-1', supplyId: 's1', lines: [] };
    mockPrisma.preInvoice.findUnique.mockResolvedValue(existing);
    mockPrisma.preInvoiceLine.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.preInvoice.update.mockResolvedValue({
      id: 'pi-1', supplyId: 's1', periodFrom: new Date('2025-01-01'), periodTo: new Date('2025-01-31'),
      tariff: 'T_2_0TD', powerTerm: 1, energyTerm: 1, excessPower: 0, reactiveEnergy: null,
      surplusCompensation: null, meterRental: 1, subtotal: 1, ieeAmount: 1, vatAmount: 1, total: 1,
      gapHoursCount: 0, gapPeriodsJson: null, createdAt: new Date(), lines: [],
    });

    const res = await runOp(server, SAVE, { variables: { i: period }, user: DOMINION });
    expect(res.errors).toBeUndefined();
    expect((res.data as { savePreInvoice: { id: string } }).savePreInvoice.id).toBe('pi-1');
    expect(mockPrisma.preInvoice.create).not.toHaveBeenCalled();
    expect(mockPrisma.preInvoice.update).toHaveBeenCalledOnce();
  });
});

// TC-PRE-019 - Pre-factura con gaps: no bloquea, expone metricas
describe('TC-PRE-019 - metricas de gap', () => {
  it('expone gapHoursCount y gapPeriodsJson sin bloquear', async () => {
    setupHappyPath2_0TD();
    tsResult = { ...defaultTs(), gapHoursByPeriod: { P1: 2, P2: 1 }, totalGapHours: 3 };
    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(res.errors).toBeUndefined();
    const d = (res.data as { calculatePreInvoice: { gapHoursCount: number; gapPeriodsJson: string } }).calculatePreInvoice;
    expect(d.gapHoursCount).toBe(3);
    expect(JSON.parse(d.gapPeriodsJson)).toEqual({ P1: 2, P2: 1 });
  });
});

// TC-PRE-021 - 3.0TD reactiva vacia -> null
describe('TC-PRE-021 - reactiva array vacio -> null', () => {
  it('reactiveEnergy null cuando el datasource devuelve null', async () => {
    setupHappyPath2_0TD({ supply: { tariff: 'T_3_0TD' } });
    // rates de reactiva presentes para que se intente cargar
    mockPrisma.reactiveEnergyRate.findMany.mockResolvedValue([
      { tier: 1, eur: 0.041554 }, { tier: 2, eur: 0.062332 },
    ]);
    // 3.0TD necesita 6 periodos de potencia/energia
    mockPrisma.tollRate.findMany.mockResolvedValue(allPeriodRates('POWER').concat(allPeriodRates('ENERGY')));
    mockPrisma.chargeRate.findMany.mockResolvedValue(allPeriodRates('POWER').concat(allPeriodRates('ENERGY')));
    mockPrisma.excessPowerRate.findMany.mockResolvedValue(allExcessRates());
    mockPrisma.contract.findFirst.mockResolvedValue(contract3_0TD());
    tsResult = { ...defaultTs(), consumptionByPeriod: { P1: 100, P2: 100, P3: 100, P4: 100, P5: 100, P6: 100 }, pvpcByPeriod: sixPvpc() };
    reactiveResult = null; // distribuidora sin datos V2

    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(res.errors).toBeUndefined();
    expect((res.data as { calculatePreInvoice: { reactiveEnergy: number | null } }).calculatePreInvoice.reactiveEnergy).toBeNull();
  });
});

// TC-PRE-022 - Periodo parcial (no meses naturales completos) -> reactiva null
describe('TC-PRE-022 - periodo parcial -> reactiva null', () => {
  it('reactiveEnergy null aunque haya datos, por no ser meses completos', async () => {
    setupHappyPath2_0TD({ supply: { tariff: 'T_3_0TD' } });
    mockPrisma.reactiveEnergyRate.findMany.mockResolvedValue([
      { tier: 1, eur: 0.041554 }, { tier: 2, eur: 0.062332 },
    ]);
    mockPrisma.tollRate.findMany.mockResolvedValue(allPeriodRates('POWER').concat(allPeriodRates('ENERGY')));
    mockPrisma.chargeRate.findMany.mockResolvedValue(allPeriodRates('POWER').concat(allPeriodRates('ENERGY')));
    mockPrisma.excessPowerRate.findMany.mockResolvedValue(allExcessRates());
    mockPrisma.contract.findFirst.mockResolvedValue(contract3_0TD());
    tsResult = { ...defaultTs(), consumptionByPeriod: { P1: 100, P2: 100, P3: 100, P4: 100, P5: 100, P6: 100 }, pvpcByPeriod: sixPvpc() };
    reactiveResult = { P1: 900 }; // habria datos, pero el periodo es parcial

    const partial = { cups: 'ES_CUPS', periodFrom: '2025-01-15', periodTo: '2025-02-14' };
    const res = await runOp(server, CALC, { variables: { i: partial }, user: DOMINION });
    expect(res.errors).toBeUndefined();
    expect((res.data as { calculatePreInvoice: { reactiveEnergy: number | null } }).calculatePreInvoice.reactiveEnergy).toBeNull();
    // El datasource de reactiva no debe ni consultarse (periodo parcial corta antes).
    expect(dataSource.loadReactiveByPeriod).not.toHaveBeenCalled();
  });
});

// ─── helpers 3.0TD ──────────────────────────────────────────────────────────
function allPeriodRates(rateType: string) {
  return [1, 2, 3, 4, 5, 6].map(p => ({ period: p, rateType, eur: 0.01 }));
}
function allExcessRates() {
  return [1, 2, 3, 4, 5, 6].map(p => ({ period: p, eurPerDay: 0.05 }));
}
function sixPvpc() {
  return { P1: 0.1, P2: 0.1, P3: 0.1, P4: 0.1, P5: 0.1, P6: 0.1 };
}
function contract3_0TD() {
  return {
    id: 'c1', supplyId: 's1', validFrom: new Date('2020-01-01'), validTo: null,
    contractedPowerP1: 50, contractedPowerP2: 50, contractedPowerP3: 50,
    contractedPowerP4: 50, contractedPowerP5: 50, contractedPowerP6: 50,
    modePowerControl: 'MAXIMETRO', hasSurplus: false, createdAt: new Date(),
  };
}
