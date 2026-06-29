import { describe, it, expect, beforeEach, vi } from 'vitest';

// SPECS §11 — Dashboard de inicio. Tests de integración (resolver + servicio) con Prisma mockeado.
const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findMany'),
    client: d('findUnique', 'findMany'),
    preInvoice: d('findMany'),
    alert: d('findMany'),
    powerOptimization: d('findMany'),
    carbonReport: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const ADMIN_A = { id: 'a1', role: 'ADMIN' as const, clientId: 'client-A' };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };

const QUERY = `query {
  dashboard {
    scope pendingApprovals clientCount
    totals { activeSupplies pendingSupplies inactiveSupplies lastPeriodCostEur prevPeriodCostEur lastPeriodKwh openAlerts openAlertsHigh annualSavingEur carbonDeltaPct }
    monthlyCost { month eur }
    recentAlerts { id cups severity }
    supplies { id cups clientName status lastPeriod lastKwh lastCostEur openAlerts annualSavingEur }
  }
}`;

const supply = (over: Record<string, unknown> = {}) => ({
  id: 's1', cups: 'ES_CUPS_1', clientId: 'client-A', tariff: 'T_3_0TD',
  status: 'ACTIVE', backfillStatus: 'DONE', ...over,
});
const preInvoice = (year: number, month: number, total: number, kwh: number) => ({
  total, periodFrom: new Date(Date.UTC(year, month, 1)), periodTo: new Date(Date.UTC(year, month + 1, 1)),
  lines: [{ quantity: kwh, unit: 'kWh' }, { quantity: 50, unit: 'kW·día' }],
});
const alert = (severity: string, status: string, detectedAt: string) => ({
  id: `al-${severity}-${status}`, supplyId: 's1', type: 'ZSCORE', severity, status, message: 'x',
  detectedAt: new Date(detectedAt),
});

// Configura los delegates por suministro. `byId` mapea supplyId → datos persistidos.
function setup(supplies: ReturnType<typeof supply>[], byId: Record<string, {
  preInvoices?: ReturnType<typeof preInvoice>[];
  alerts?: ReturnType<typeof alert>[];
  opt?: { annualSaving: number; recommendChange: boolean };
  carbon?: { deltaPct: number; totalKwh: number };
}>, clients: Record<string, { id: string; name: string }> = { 'client-A': { id: 'client-A', name: 'ACME' } }) {
  mockPrisma.supply.findMany.mockImplementation(async ({ where = {} }: { where?: Record<string, unknown> }) =>
    supplies.filter(s => Object.keys(where).every(k => (where as Record<string, unknown>)[k] === (s as Record<string, unknown>)[k])),
  );
  mockPrisma.client.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => clients[where.id] ?? null);
  mockPrisma.client.findMany.mockResolvedValue(Object.values(clients));
  mockPrisma.preInvoice.findMany.mockImplementation(async ({ where }: { where: { supplyId: string } }) => byId[where.supplyId]?.preInvoices ?? []);
  mockPrisma.alert.findMany.mockImplementation(async ({ where }: { where: { supplyId: string } }) => byId[where.supplyId]?.alerts ?? []);
  mockPrisma.powerOptimization.findMany.mockImplementation(async ({ where }: { where: { supplyId: string } }) => { const o = byId[where.supplyId]?.opt; return o ? [o] : []; });
  mockPrisma.carbonReport.findMany.mockImplementation(async ({ where }: { where: { supplyId: string } }) => { const c = byId[where.supplyId]?.carbon; return c ? [c] : []; });
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
});

describe('TC-DASH-001 — ADMIN agrega solo su clientId', () => {
  it('filtra supply.findMany por clientId y suma las últimas pre-facturas', async () => {
    setup([supply()], { s1: { preInvoices: [preInvoice(2026, 4, 17000, 80000)] } });
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.supply.findMany).toHaveBeenCalledWith({ where: { clientId: 'client-A' } });
    const d = r.data?.dashboard as { scope: string; totals: { lastPeriodCostEur: number; lastPeriodKwh: number } };
    expect(d.scope).toBe('CLIENT');
    expect(d.totals.lastPeriodCostEur).toBe(17000);
    expect(d.totals.lastPeriodKwh).toBe(80000);
  });
});

describe('TC-DASH-002 — variación de coste último vs anterior', () => {
  it('expone coste último y anterior; prev null sin penúltima', async () => {
    setup([supply()], { s1: { preInvoices: [preInvoice(2026, 4, 17000, 80000), preInvoice(2026, 3, 16000, 78000)] } });
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    const t = (r.data?.dashboard as { totals: { lastPeriodCostEur: number; prevPeriodCostEur: number | null } }).totals;
    expect(t.lastPeriodCostEur).toBe(17000);
    expect(t.prevPeriodCostEur).toBe(16000);

    setup([supply()], { s1: { preInvoices: [preInvoice(2026, 4, 17000, 80000)] } });
    const r2 = await runOp(server, QUERY, { user: ADMIN_A });
    expect((r2.data?.dashboard as { totals: { prevPeriodCostEur: number | null } }).totals.prevPeriodCostEur).toBeNull();
  });
});

describe('TC-DASH-003 — recuento de alertas abiertas', () => {
  it('cuenta NEW+ACKNOWLEDGED (no DISMISSED); CRITICAL → high', async () => {
    setup([supply()], { s1: { alerts: [
      alert('CRITICAL', 'NEW', '2026-05-20T10:00:00.000Z'),
      alert('WARNING', 'ACKNOWLEDGED', '2026-05-19T10:00:00.000Z'),
      alert('INFO', 'DISMISSED', '2026-05-18T10:00:00.000Z'),
    ] } });
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    const t = (r.data?.dashboard as { totals: { openAlerts: number; openAlertsHigh: number } }).totals;
    expect(t.openAlerts).toBe(2);
    expect(t.openAlertsHigh).toBe(1);
  });
});

describe('TC-DASH-004 — ahorro potencial (solo recommendChange)', () => {
  it('suma annualSaving de optimizaciones recomendadas e ignora las no recomendadas', async () => {
    setup(
      [supply({ id: 's1', cups: 'C1' }), supply({ id: 's2', cups: 'C2' })],
      {
        s1: { opt: { annualSaving: 1000, recommendChange: true } },
        s2: { opt: { annualSaving: 5000, recommendChange: false } },
      },
    );
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    expect((r.data?.dashboard as { totals: { annualSavingEur: number } }).totals.annualSavingEur).toBe(1000);
  });
});

describe('TC-DASH-005 — GESTOR/USUARIO: scope de suministro único', () => {
  it('filtra por id del supply y devuelve cartera de 1 fila', async () => {
    setup([supply({ id: 's1' })], { s1: { preInvoices: [preInvoice(2026, 4, 900, 4000)] } });
    const r = await runOp(server, QUERY, { user: USUARIO_S1 });
    expect(mockPrisma.supply.findMany).toHaveBeenCalledWith({ where: { id: 's1' } });
    const d = r.data?.dashboard as { scope: string; supplies: unknown[] };
    expect(d.scope).toBe('SUPPLY');
    expect(d.supplies).toHaveLength(1);
  });
});

describe('TC-DASH-006 — extras de DOMINION', () => {
  it('cuenta solicitudes pendientes y clientes', async () => {
    setup(
      [supply({ id: 's1', status: 'ACTIVE' }), supply({ id: 's2', status: 'PENDING_APPROVAL', clientId: 'client-B' })],
      {},
      { 'client-A': { id: 'client-A', name: 'ACME' }, 'client-B': { id: 'client-B', name: 'Beta' } },
    );
    const r = await runOp(server, QUERY, { user: DOMINION });
    const d = r.data?.dashboard as { scope: string; pendingApprovals: number; clientCount: number };
    expect(mockPrisma.supply.findMany).toHaveBeenCalledWith({ where: {} });
    expect(d.scope).toBe('PLATFORM');
    expect(d.pendingApprovals).toBe(1);
    expect(d.clientCount).toBe(2);
  });
});

describe('TC-DASH-007 — suministro sin pre-factura', () => {
  it('lastCostEur null y no rompe la agregación', async () => {
    setup([supply()], { s1: {} });
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    expect(r.errors).toBeUndefined();
    const d = r.data?.dashboard as { totals: { lastPeriodCostEur: number | null }; supplies: { lastCostEur: number | null }[] };
    expect(d.totals.lastPeriodCostEur).toBeNull();
    expect(d.supplies[0].lastCostEur).toBeNull();
  });
});

describe('TC-DASH-008 — serie mensual', () => {
  it('agrupa por YYYY-MM, ordena asc y limita a 6', async () => {
    const pis = Array.from({ length: 9 }, (_, i) => preInvoice(2026, i, 1000 + i, 100));
    setup([supply()], { s1: { preInvoices: pis } });
    const r = await runOp(server, QUERY, { user: ADMIN_A });
    const months = (r.data?.dashboard as { monthlyCost: { month: string }[] }).monthlyCost.map(m => m.month);
    expect(months).toHaveLength(6);
    expect(months).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  });
});

describe('TC-DASH-009 — sin autenticar', () => {
  it('UNAUTHENTICATED', async () => {
    const r = await runOp(server, QUERY, { user: null });
    expect(errorCode(r)).toBe('UNAUTHENTICATED');
  });
});
