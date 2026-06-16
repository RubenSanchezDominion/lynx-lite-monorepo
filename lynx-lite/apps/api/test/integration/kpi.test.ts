import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique'),
    productionUpload: d('findUnique', 'create'),
    kpiReport: d('findUnique', 'create', 'update', 'findMany'),
    kpiReportLine: d('deleteMany'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setKpiDataSource } from '../../src/services/runtime.js';
import type { KpiDataSource, RawConsumptionHour } from '../../src/services/kpiData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };
const ADMIN_OTHER = { id: 'a2', role: 'ADMIN' as const, clientId: 'client-B' };

let rawHours: RawConsumptionHour[];
const dataSource: KpiDataSource = { load: vi.fn(async () => rawHours) };
setKpiDataSource(dataSource);

// Curva demo: una hora a las 10:00Z (=12:00 Madrid CEST → P1 en 2.0TD), 10 kWh, PVPC 0.10 €/kWh.
function defaultHours(): RawConsumptionHour[] {
  return [{ ts: '2026-06-01T10:00:00.000Z', hours: 1, kwh: 10, pvpcEurKwh: 0.1, gap: false }];
}

function setupSupply(over: Record<string, unknown> = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE', ...over,
  });
}

// Maestros de energía (peaje + cargo) por período de 2.0TD (P1–P3). Solo P1 se usa en la curva demo.
function setupRates() {
  mockPrisma.tollRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.02 })));
  mockPrisma.chargeRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.01 })));
}

function makeUpload(over: Record<string, unknown> = {}) {
  return {
    id: 'up1',
    supplyId: 's1',
    rangeStart: new Date('2026-06-01T10:00:00.000Z'),
    rangeEnd: new Date('2026-06-01T11:00:00.000Z'),
    supply: { id: 's1', clientId: 'client-A', cups: 'ES_CUPS', tariff: 'T_2_0TD', backfillStatus: 'DONE' },
    rows: [
      { startTs: new Date('2026-06-01T10:00:00.000Z'), endTs: new Date('2026-06-01T11:00:00.000Z'), units: 100, shift: null, line: null, batch: null },
    ],
    ...over,
  };
}

function makeReport(over: Record<string, unknown> = {}) {
  return {
    id: 'rep1', supplyId: 's1', uploadId: 'up1', granularity: 'DAY',
    rangeStart: new Date('2026-06-01T10:00:00.000Z'), rangeEnd: new Date('2026-06-01T11:00:00.000Z'),
    totalUnits: 100, totalKwh: 10, totalCostEur: 1.3, avgEurPerUnit: 0.013, baselineEurPerUnit: 0.013,
    outlierPct: 0.2, hasGaps: false, computedAt: new Date(),
    lines: [{ bucketKey: '2026-06-01', bucketStart: new Date('2026-06-01T10:00:00.000Z'), units: 100, kwh: 10, costEur: 1.3, eurPerUnit: 0.013, isOutlier: false }],
    ...over,
  };
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.load as ReturnType<typeof vi.fn>).mockClear();
  rawHours = defaultHours();
});

const SUBMIT = `mutation($i: SubmitProductionInput!) { submitProductionData(input: $i) { id rowCount } }`;
const COMPUTE = `mutation($i: ComputeKpiInput!) { computeKpi(input: $i) { id granularity totalCostEur lines { bucketKey eurPerUnit } } }`;
const GET = `query($id: ID!) { kpiReport(id: $id) { id } }`;
const UPLOADS = `query($s: String!) { productionUploads(supplyId: $s) { id rowCount } }`;

const validRows = [{ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T14:00:00.000Z', units: 100 }];
const submitInput = (rows: unknown[]) => ({ cups: 'ES_CUPS', fileName: 'p.csv', format: 'CSV', rows });

describe('TC-KPI-013 — submitProductionData valida y persiste', () => {
  it('filas válidas → crea ProductionUpload + filas', async () => {
    setupSupply();
    mockPrisma.productionUpload.create.mockResolvedValue({ id: 'up1', rowCount: 1 });
    mockPrisma.productionUpload.findUnique.mockResolvedValue({
      id: 'up1', supplyId: 's1', fileName: 'p.csv', format: 'CSV', rowCount: 1,
      rangeStart: new Date('2026-06-01T06:00:00.000Z'), rangeEnd: new Date('2026-06-01T14:00:00.000Z'), uploadedAt: new Date(),
    });
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(validRows) }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.productionUpload.create).toHaveBeenCalledTimes(1);
    expect((r.data?.submitProductionData as { id: string }).id).toBe('up1');
  });
  it('sin filas → KPI_NO_PRODUCTION_DATA', async () => {
    setupSupply();
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput([]) }, user: DOMINION });
    expect(errorCode(r)).toBe('KPI_NO_PRODUCTION_DATA');
    expect(mockPrisma.productionUpload.create).not.toHaveBeenCalled();
  });
});

describe('TC-KPI-014 — fila inválida → KPI_INVALID_ROW', () => {
  it('endTs ≤ startTs', async () => {
    setupSupply();
    const rows = [{ startTs: '2026-06-01T14:00:00.000Z', endTs: '2026-06-01T06:00:00.000Z', units: 100 }];
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(rows) }, user: DOMINION });
    expect(errorCode(r)).toBe('KPI_INVALID_ROW');
  });
  it('units ≤ 0', async () => {
    setupSupply();
    const rows = [{ startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T14:00:00.000Z', units: 0 }];
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(rows) }, user: DOMINION });
    expect(errorCode(r)).toBe('KPI_INVALID_ROW');
  });
});

describe('TC-KPI-015 — tramos solapados → KPI_OVERLAPPING_INTERVALS', () => {
  it('dos tramos con solape temporal', async () => {
    setupSupply();
    const rows = [
      { startTs: '2026-06-01T06:00:00.000Z', endTs: '2026-06-01T14:00:00.000Z', units: 100 },
      { startTs: '2026-06-01T12:00:00.000Z', endTs: '2026-06-01T20:00:00.000Z', units: 100 },
    ];
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(rows) }, user: DOMINION });
    expect(errorCode(r)).toBe('KPI_OVERLAPPING_INTERVALS');
  });
});

describe('TC-KPI-016 — computeKpi calcula y persiste', () => {
  it('upload + curva → KpiReport con líneas', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(makeUpload());
    setupRates();
    mockPrisma.kpiReport.findUnique.mockResolvedValue(null);
    mockPrisma.kpiReport.create.mockResolvedValue(makeReport());
    const r = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1', granularity: 'DAY' } }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.kpiReport.create).toHaveBeenCalledTimes(1);
    expect((r.data?.computeKpi as { id: string }).id).toBe('rep1');
  });
  it('uploadId inexistente → KPI_UPLOAD_NOT_FOUND', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(null);
    const r = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'nope' } }, user: DOMINION });
    expect(errorCode(r)).toBe('KPI_UPLOAD_NOT_FOUND');
  });
  it('sin curva en el rango → NO_CONSUMPTION_DATA', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(makeUpload());
    setupRates();
    rawHours = [];
    const r = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1' } }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });
});

describe('TC-KPI-017 — computeKpi idempotente por (uploadId, granularity)', () => {
  it('segunda ejecución actualiza el mismo report (no duplica)', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(makeUpload());
    setupRates();
    // 1ª: no existe → create.
    mockPrisma.kpiReport.findUnique.mockResolvedValueOnce(null);
    mockPrisma.kpiReport.create.mockResolvedValue(makeReport());
    const r1 = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1', granularity: 'DAY' } }, user: DOMINION });
    expect(r1.errors).toBeUndefined();

    // 2ª: existe → deleteMany + update.
    mockPrisma.kpiReport.findUnique.mockResolvedValueOnce({ id: 'rep1' });
    mockPrisma.kpiReport.update.mockResolvedValue(makeReport());
    const r2 = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1', granularity: 'DAY' } }, user: DOMINION });
    expect(r2.errors).toBeUndefined();

    expect(mockPrisma.kpiReport.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.kpiReport.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.kpiReportLine.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('TC-KPI-018 — reutiliza la composición de precio de M01', () => {
  it('eurPerKwh = pvpc + peajeE + cargoE → coste coherente', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(makeUpload());
    setupRates(); // peajeE=0.02, cargoE=0.01
    mockPrisma.kpiReport.findUnique.mockResolvedValue(null);
    mockPrisma.kpiReport.create.mockResolvedValue(makeReport());
    await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1', granularity: 'DAY' } }, user: DOMINION });
    // 10 kWh × (0.10 + 0.02 + 0.01) = 1.30 €
    const data = mockPrisma.kpiReport.create.mock.calls[0][0].data as { totalCostEur: number };
    expect(data.totalCostEur).toBeCloseTo(1.3, 6);
  });
});

describe('TC-KPI-019 — consultas y autorización', () => {
  it('kpiReport(id) inexistente → null (sin error)', async () => {
    mockPrisma.kpiReport.findUnique.mockResolvedValue(null);
    const r = await runOp(server, GET, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.kpiReport).toBeNull();
  });
  it('USUARIO no puede subir (submitProductionData → FORBIDDEN)', async () => {
    setupSupply();
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(validRows) }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.productionUpload.create).not.toHaveBeenCalled();
  });
  it('USUARIO no puede calcular (computeKpi → FORBIDDEN)', async () => {
    mockPrisma.productionUpload.findUnique.mockResolvedValue(makeUpload());
    const r = await runOp(server, COMPUTE, { variables: { i: { uploadId: 'up1' } }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.kpiReport.create).not.toHaveBeenCalled();
  });
  it('ADMIN de otro cliente no lista uploads ajenos (→ FORBIDDEN)', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    const r = await runOp(server, UPLOADS, { variables: { s: 's1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('TC-KPI-020 — backfill no listo → BACKFILL_*', () => {
  it('RUNNING en submitProductionData', async () => {
    setupSupply({ backfillStatus: 'RUNNING' });
    const r = await runOp(server, SUBMIT, { variables: { i: submitInput(validRows) }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_RUNNING');
  });
});
