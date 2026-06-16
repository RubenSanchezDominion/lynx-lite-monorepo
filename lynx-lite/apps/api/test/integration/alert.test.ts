import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique'),
    contract: d('findFirst'),
    alertConfig: d('findUnique', 'create', 'update'),
    alert: d('findUnique', 'findMany', 'create', 'update'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setAlertDataSource } from '../../src/services/runtime.js';
import type { AlertDataSource, AlertSeries } from '../../src/services/alertData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };
const ADMIN_OTHER = { id: 'a2', role: 'ADMIN' as const, clientId: 'client-B' };

let seriesResult: AlertSeries;
const dataSource: AlertDataSource = { load: vi.fn(async () => seriesResult) };
setAlertDataSource(dataSource);

function defaultSeries(): AlertSeries {
  return {
    targetDay: [
      { ts: '2025-06-09T12:00:00.000Z', localHour: 12, weekday: 1, period: 1, kwh: 30, estimated: false, gap: false },
      { ts: '2025-06-09T15:00:00.000Z', localHour: 15, weekday: 1, period: 1, kwh: 30, estimated: true, gap: true },
    ],
    referenceBySlot: {},
    intervalHours: 1,
    referenceWeeks: 13,
    hasUsableData: true,
  };
}

function setupSupply(over: Record<string, unknown> = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_3_0TD', backfillStatus: 'DONE', ...over,
  });
}

function setupConfig(enabledTypes: string) {
  mockPrisma.alertConfig.findUnique.mockResolvedValue({
    id: 'cfg-1', supplyId: 's1', enabled: true, sensitivity: 'EQUILIBRADO', enabledTypes,
    limitThresholdPct: 0.95, phantomThresholdKwh: 1, inactivityWindows: [], updatedAt: new Date(),
  });
}

function makeAlertRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, supplyId: 's1', type: 'ESTIMATED', severity: 'INFO', status: 'NEW', period: 1,
    windowStart: new Date('2025-06-09T15:00:00.000Z'), windowEnd: new Date('2025-06-09T16:00:00.000Z'),
    observedValue: 30, expectedValue: null, deviation: null, message: 'x', detectedAt: new Date(),
    acknowledgedBy: null, acknowledgedAt: null, supply: { id: 's1', clientId: 'client-A' }, ...over,
  };
}

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.load as ReturnType<typeof vi.fn>).mockClear();
  seriesResult = defaultSeries();
});

const EVAL = `mutation($i: EvaluateAlertsInput!) { evaluateAlerts(input: $i) { type severity status } }`;
const SAVE_CFG = `mutation($i: AlertConfigInput!) { saveAlertConfig(input: $i) { id sensitivity enabledTypes } }`;
const ACK = `mutation($id: ID!) { acknowledgeAlert(id: $id) { id status } }`;
const DISMISS = `mutation($id: ID!) { dismissAlert(id: $id) { id status } }`;
const LIST = `query($s: String!, $st: String, $t: String, $l: Int, $o: Int) {
  alerts(supplyId: $s, status: $st, type: $t, limit: $l, offset: $o) { id type status }
}`;
const GET = `query($id: ID!) { alert(id: $id) { id status } }`;

describe('TC-ALT-010 — histórico insuficiente → INSUFFICIENT_HISTORY', () => {
  it('< 13 semanas de referencia con ZSCORE activo', async () => {
    setupSupply();
    setupConfig('ZSCORE');
    seriesResult = { ...defaultSeries(), referenceWeeks: 5 };
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: DOMINION });
    expect(errorCode(r)).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('TC-ALT-011 — saveAlertConfig idempotente por suministro', () => {
  it('primera llamada crea, segunda actualiza la misma config', async () => {
    setupSupply();
    mockPrisma.alertConfig.findUnique.mockResolvedValueOnce(null); // 1ª: no existe
    mockPrisma.alertConfig.create.mockResolvedValue({
      id: 'cfg-1', supplyId: 's1', enabled: true, sensitivity: 'AGRESIVO',
      enabledTypes: 'ZSCORE', limitThresholdPct: 0.95, phantomThresholdKwh: 0, inactivityWindows: [], updatedAt: new Date(),
    });
    const input = { cups: 'ES_CUPS', sensitivity: 'AGRESIVO', enabledTypes: ['ZSCORE'] };
    const r1 = await runOp(server, SAVE_CFG, { variables: { i: input }, user: DOMINION });
    expect(r1.errors).toBeUndefined();

    mockPrisma.alertConfig.findUnique.mockResolvedValueOnce({ id: 'cfg-1', supplyId: 's1' });
    mockPrisma.alertConfig.update.mockResolvedValue({
      id: 'cfg-1', supplyId: 's1', enabled: true, sensitivity: 'CONSERVADOR',
      enabledTypes: 'ZSCORE,LIMIT', limitThresholdPct: 0.9, phantomThresholdKwh: 0, inactivityWindows: [], updatedAt: new Date(),
    });
    const r2 = await runOp(server, SAVE_CFG, { variables: { i: { ...input, sensitivity: 'CONSERVADOR' } }, user: DOMINION });
    expect(r2.errors).toBeUndefined();
    expect(mockPrisma.alertConfig.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.alertConfig.update).toHaveBeenCalledTimes(1);
  });
});

describe('TC-ALT-012 — acknowledgeAlert cambia el estado', () => {
  it('NEW → ACKNOWLEDGED', async () => {
    mockPrisma.alert.findUnique.mockResolvedValue(makeAlertRow('al-1'));
    mockPrisma.alert.update.mockResolvedValue(makeAlertRow('al-1', { status: 'ACKNOWLEDGED', acknowledgedBy: 'dom', acknowledgedAt: new Date() }));
    const r = await runOp(server, ACK, { variables: { id: 'al-1' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect((r.data?.acknowledgeAlert as { status: string }).status).toBe('ACKNOWLEDGED');
  });
  it('id inexistente → ALERT_NOT_FOUND', async () => {
    mockPrisma.alert.findUnique.mockResolvedValue(null);
    const r = await runOp(server, ACK, { variables: { id: 'nope' }, user: DOMINION });
    expect(errorCode(r)).toBe('ALERT_NOT_FOUND');
  });
});

describe('TC-ALT-013 — dismissAlert descarta', () => {
  it('NEW → DISMISSED', async () => {
    mockPrisma.alert.findUnique.mockResolvedValue(makeAlertRow('al-1'));
    mockPrisma.alert.update.mockResolvedValue(makeAlertRow('al-1', { status: 'DISMISSED' }));
    const r = await runOp(server, DISMISS, { variables: { id: 'al-1' }, user: DOMINION });
    expect((r.data?.dismissAlert as { status: string }).status).toBe('DISMISSED');
  });
});

describe('TC-ALT-014 — alerts(list) con filtros y paginación', () => {
  it('delega where/orderBy/take/skip a Prisma', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    mockPrisma.alert.findMany.mockResolvedValue([makeAlertRow('a1'), makeAlertRow('a2')]);
    const r = await runOp(server, LIST, { variables: { s: 's1', st: 'NEW', t: 'PHANTOM', l: 10, o: 0 }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supplyId: 's1', status: 'NEW', type: 'PHANTOM' },
        orderBy: { windowStart: 'desc' },
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

describe('TC-ALT-015 — alert(id)', () => {
  it('inexistente → null (sin error)', async () => {
    mockPrisma.alert.findUnique.mockResolvedValue(null);
    const r = await runOp(server, GET, { variables: { id: 'nope' }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(r.data?.alert).toBeNull();
  });
  it('ADMIN de otro cliente → FORBIDDEN', async () => {
    mockPrisma.alert.findUnique.mockResolvedValue(makeAlertRow('al-1'));
    const r = await runOp(server, GET, { variables: { id: 'al-1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('TC-ALT-016 — autorización', () => {
  it('USUARIO no puede configurar (saveAlertConfig → FORBIDDEN)', async () => {
    setupSupply(); // clientId client-A, id s1; USUARIO_S1.supplyId=s1 pasa el acceso
    const r = await runOp(server, SAVE_CFG, { variables: { i: { cups: 'ES_CUPS' } }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
    expect(mockPrisma.alertConfig.create).not.toHaveBeenCalled();
  });
  it('USUARIO no puede evaluar (evaluateAlerts → FORBIDDEN)', async () => {
    setupSupply();
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
  it('ADMIN de otro cliente no lista alertas ajenas (→ FORBIDDEN)', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({ id: 's1', clientId: 'client-A' });
    const r = await runOp(server, LIST, { variables: { s: 's1' }, user: ADMIN_OTHER });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('TC-ALT-017 — evaluateAlerts manual persiste alertas', () => {
  it('detecta y crea (status NEW)', async () => {
    setupSupply();
    setupConfig('ESTIMATED');
    mockPrisma.alert.findUnique.mockResolvedValue(null); // no existía
    mockPrisma.alert.create.mockResolvedValue(makeAlertRow('new-1'));
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS', day: '2025-06-09' } }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const out = r.data?.evaluateAlerts as { type: string }[];
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ESTIMATED');
    expect(mockPrisma.alert.create).toHaveBeenCalledTimes(1);
  });
  it('sin AlertConfig → ALERT_CONFIG_NOT_FOUND', async () => {
    setupSupply();
    mockPrisma.alertConfig.findUnique.mockResolvedValue(null);
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: DOMINION });
    expect(errorCode(r)).toBe('ALERT_CONFIG_NOT_FOUND');
  });
});

describe('TC-ALT-018 — idempotencia del job: no revive gestionadas', () => {
  it('alerta ACKNOWLEDGED no se re-crea ni vuelve a NEW', async () => {
    setupSupply();
    setupConfig('ESTIMATED');
    mockPrisma.alert.findUnique.mockResolvedValue(
      makeAlertRow('ex-1', { status: 'ACKNOWLEDGED', type: 'ESTIMATED' }),
    );
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS', day: '2025-06-09' } }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const out = r.data?.evaluateAlerts as { status: string }[];
    expect(out[0].status).toBe('ACKNOWLEDGED');
    expect(mockPrisma.alert.create).not.toHaveBeenCalled();
    expect(mockPrisma.alert.update).not.toHaveBeenCalled();
  });
});

describe('TC-ALT-019 — backfill no listo → BACKFILL_*', () => {
  it('RUNNING', async () => {
    setupSupply({ backfillStatus: 'RUNNING' });
    setupConfig('ZSCORE');
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_RUNNING');
  });
});

describe('TC-ALT-020 — sin curva del día → NO_CONSUMPTION_DATA', () => {
  it('hasUsableData=false', async () => {
    setupSupply();
    setupConfig('ZSCORE');
    seriesResult = { ...defaultSeries(), hasUsableData: false };
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });
});

describe('TC-ALT-021 — LIMIT sin contrato → CONTRACT_NOT_FOUND', () => {
  it('LIMIT activo y sin contrato vigente', async () => {
    setupSupply();
    setupConfig('LIMIT');
    mockPrisma.contract.findFirst.mockResolvedValue(null);
    const r = await runOp(server, EVAL, { variables: { i: { cups: 'ES_CUPS' } }, user: DOMINION });
    expect(errorCode(r)).toBe('CONTRACT_NOT_FOUND');
  });
});
