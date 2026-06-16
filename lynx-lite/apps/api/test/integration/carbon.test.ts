import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique'),
    carbonReport: d('findUnique', 'create', 'update', 'findMany'),
    carbonReportLine: d('deleteMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setCarbonDataSource, setCo2Ingestion } from '../../src/services/runtime.js';
import type { CarbonDataSource, RawCarbonHour } from '../../src/services/carbonData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };
const ADMIN_OTHER = { id: 'a2', role: 'ADMIN' as const, clientId: 'client-B' };

let rawHours: RawCarbonHour[];
const dataSource: CarbonDataSource = { load: vi.fn(async () => rawHours) };
setCarbonDataSource(dataSource);
const ingestion = vi.fn(async () => {});
setCo2Ingestion(ingestion);

// Dos horas en enero (Madrid +01 → mes "2026-01"): una limpia (factor 100) con mucho consumo y una
// sucia (factor 500) con poco → factor propio 140 < media nacional 300 → deltaPct ≈ −0.533.
function defaultHours(): RawCarbonHour[] {
  return [
    { ts: '2026-01-01T12:00:00.000Z', kwh: 90, gap: false, factorGPerKwh: 100 },
    { ts: '2026-01-01T20:00:00.000Z', kwh: 10, gap: false, factorGPerKwh: 500 },
  ];
}

function setupSupply(over: Record<string, unknown> = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE', ...over,
  });
}

function makeReport(over: Record<string, unknown> = {}) {
  return {
    id: 'crep1', supplyId: 's1',
    rangeStart: new Date('2026-01-01T00:00:00.000Z'), rangeEnd: new Date('2026-02-01T00:00:00.000Z'),
    totalKwh: 100, totalCo2Kg: 14, ownFactorGPerKwh: 140, nationalAvgFactor: 300, deltaPct: -0.5333,
    hasGaps: false, computedAt: new Date(),
    lines: [{ monthKey: '2026-01', monthStart: new Date('2026-01-01T12:00:00.000Z'), kwh: 100, co2Kg: 14, factorAvg: 140, hasGaps: false }],
    ...over,
  };
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.load as ReturnType<typeof vi.fn>).mockClear();
  ingestion.mockClear();
  rawHours = defaultHours();
});

const COMPUTE = `mutation($i: ComputeCarbonInput!) { computeCarbonFootprint(input: $i) { id totalCo2Kg deltaPct lines { monthKey co2Kg } } }`;
const GET = `query($id: ID!) { carbonReport(id: $id) { id } }`;
const LIST = `query($s: String!) { carbonReports(supplyId: $s) { id } }`;
const input = { cups: 'ES_CUPS', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };

describe('TC-CO2-011 — computeCarbonFootprint calcula y persiste', () => {
  it('curva + factor → CarbonReport con líneas mensuales y emisiones correctas', async () => {
    setupSupply();
    mockPrisma.carbonReport.findUnique.mockResolvedValue(null);
    mockPrisma.carbonReport.create.mockResolvedValue(makeReport());
    const r = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.carbonReport.create).toHaveBeenCalledTimes(1);
    // El engine compuso las emisiones: (90·100 + 10·500)/1000 = 14 kgCO₂; own=140, nacional=300.
    const data = mockPrisma.carbonReport.create.mock.calls[0][0].data as { totalCo2Kg: number; deltaPct: number };
    expect(data.totalCo2Kg).toBeCloseTo(14, 6);
    expect(data.deltaPct).toBeCloseTo(-0.5333, 3);
  });
  it('sin curva en el rango → NO_CONSUMPTION_DATA', async () => {
    setupSupply();
    rawHours = [];
    const r = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });
});

describe('TC-CO2-012 — ingesta on-demand del factor / CO2_NO_FACTOR_DATA', () => {
  it('invoca la ingesta del factor antes de cargar', async () => {
    setupSupply();
    mockPrisma.carbonReport.findUnique.mockResolvedValue(null);
    mockPrisma.carbonReport.create.mockResolvedValue(makeReport());
    await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(ingestion).toHaveBeenCalledTimes(1);
    expect(ingestion).toHaveBeenCalledWith(new Date(input.from), new Date(input.to));
  });
  it('sin factor en todo el rango → CO2_NO_FACTOR_DATA', async () => {
    setupSupply();
    rawHours = defaultHours().map(h => ({ ...h, factorGPerKwh: null }));
    const r = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('CO2_NO_FACTOR_DATA');
  });
});

describe('TC-CO2-013 — idempotente por (supplyId, rango)', () => {
  it('segunda ejecución actualiza el mismo report (no duplica)', async () => {
    setupSupply();
    mockPrisma.carbonReport.findUnique.mockResolvedValueOnce(null);
    mockPrisma.carbonReport.create.mockResolvedValue(makeReport());
    const r1 = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(r1.errors).toBeUndefined();

    setupSupply();
    mockPrisma.carbonReport.findUnique.mockResolvedValueOnce({ id: 'crep1' });
    mockPrisma.carbonReport.update.mockResolvedValue(makeReport());
    const r2 = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(r2.errors).toBeUndefined();

    expect(mockPrisma.carbonReport.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.carbonReport.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.carbonReportLine.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('TC-CO2-014 — backfill no listo → BACKFILL_*', () => {
  it('RUNNING → BACKFILL_RUNNING', async () => {
    setupSupply({ backfillStatus: 'RUNNING' });
    const r = await runOp(server, COMPUTE, { variables: { i: input }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_RUNNING');
  });
});

describe('TC-CO2-015 — consultas y autorización', () => {
  it('carbonReport(id) inexistente → null (sin error)', async () => {
    mockPrisma.carbonReport.findUnique.mockResolvedValue(null);
    const r = await runOp(server, GET, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.carbonReport).toBeNull();
  });
  it('USUARIO no puede calcular (computeCarbonFootprint → FORBIDDEN)', async () => {
    setupSupply();
    const r = await runOp(server, COMPUTE, { variables: { i: input }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.carbonReport.create).not.toHaveBeenCalled();
  });
  it('ADMIN de otro cliente no lista informes ajenos (→ FORBIDDEN)', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    const r = await runOp(server, LIST, { variables: { s: 's1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});
