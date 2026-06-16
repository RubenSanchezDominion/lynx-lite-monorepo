import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getAlertDataSource } from '../../services/runtime.js';
import { runAlertEvaluation, persistDetectedAlerts } from '../../services/alertService.js';

const ALL_TYPES = ['ZSCORE', 'PHANTOM', 'LIMIT', 'ESTIMATED'];

interface AlertRow {
  id: string;
  supplyId: string;
  type: string;
  severity: string;
  status: string;
  period: number;
  windowStart: Date;
  windowEnd: Date;
  observedValue: number;
  expectedValue: number | null;
  deviation: number | null;
  message: string;
  detectedAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
}

interface AlertConfigRow {
  id: string;
  supplyId: string;
  enabled: boolean;
  sensitivity: string;
  enabledTypes: string;
  limitThresholdPct: number;
  phantomThresholdKwh: number;
  inactivityWindows: unknown;
  updatedAt: Date;
}

function alertToGql(a: AlertRow) {
  return {
    id: a.id,
    supplyId: a.supplyId,
    type: a.type,
    severity: a.severity,
    status: a.status,
    period: a.period,
    windowStart: a.windowStart.toISOString(),
    windowEnd: a.windowEnd.toISOString(),
    observedValue: a.observedValue,
    expectedValue: a.expectedValue,
    deviation: a.deviation,
    message: a.message,
    detectedAt: a.detectedAt.toISOString(),
    acknowledgedBy: a.acknowledgedBy ?? null,
    acknowledgedAt: a.acknowledgedAt ? a.acknowledgedAt.toISOString() : null,
  };
}

function configToGql(c: AlertConfigRow) {
  return {
    id: c.id,
    supplyId: c.supplyId,
    enabled: c.enabled,
    sensitivity: c.sensitivity,
    enabledTypes: c.enabledTypes
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    limitThresholdPct: c.limitThresholdPct,
    phantomThresholdKwh: c.phantomThresholdKwh,
    inactivityWindows: Array.isArray(c.inactivityWindows) ? c.inactivityWindows : [],
    updatedAt: c.updatedAt.toISOString(),
  };
}

export interface AlertConfigInput {
  cups: string;
  enabled?: boolean;
  sensitivity?: string;
  enabledTypes?: string[];
  limitThresholdPct?: number;
  phantomThresholdKwh?: number;
  inactivityWindows?: { days: number[]; from: string; to: string }[];
}

export const alertResolvers = {
  Query: {
    alerts: async (
      _p: unknown,
      args: { supplyId: string; status?: string; type?: string; limit?: number; offset?: number },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const where: Record<string, unknown> = { supplyId: args.supplyId };
      if (args.status) where.status = args.status;
      if (args.type) where.type = args.type;

      const list = (await prisma.alert.findMany({
        where,
        orderBy: { windowStart: 'desc' },
        take: args.limit ?? 100,
        skip: args.offset ?? 0,
      })) as AlertRow[];
      return list.map(alertToGql);
    },

    alert: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const a = await prisma.alert.findUnique({
        where: { id: args.id },
        include: { supply: true },
      });
      if (!a) return null;
      assertSupplyAccess(actor, (a as unknown as { supply: { id: string; clientId: string } }).supply);
      return alertToGql(a as unknown as AlertRow);
    },

    alertConfig: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const c = (await prisma.alertConfig.findUnique({
        where: { supplyId: args.supplyId },
      })) as AlertConfigRow | null;
      return c ? configToGql(c) : null;
    },
  },

  Mutation: {
    saveAlertConfig: async (
      _p: unknown,
      args: { input: AlertConfigInput },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN

      const i = args.input;
      const data = {
        enabled: i.enabled ?? true,
        sensitivity: (i.sensitivity ?? 'EQUILIBRADO') as 'CONSERVADOR' | 'EQUILIBRADO' | 'AGRESIVO',
        enabledTypes: (i.enabledTypes ?? ALL_TYPES).join(','),
        limitThresholdPct: i.limitThresholdPct ?? 0.95,
        phantomThresholdKwh: i.phantomThresholdKwh ?? 0,
        inactivityWindows: i.inactivityWindows ?? [],
      };

      // Idempotente por supplyId (1 config por suministro).
      const existing = (await prisma.alertConfig.findUnique({
        where: { supplyId: supply.id },
      })) as AlertConfigRow | null;

      const saved = existing
        ? await prisma.alertConfig.update({ where: { supplyId: supply.id }, data })
        : await prisma.alertConfig.create({ data: { supplyId: supply.id, ...data } });
      return configToGql(saved as unknown as AlertConfigRow);
    },

    evaluateAlerts: async (
      _p: unknown,
      args: { input: { cups: string; day?: string } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor);

      const computed = await runAlertEvaluation(args.input, {
        prisma,
        dataSource: getAlertDataSource(),
      });
      const persisted = await persistDetectedAlerts(computed.supply.id, computed.alerts, prisma);
      return (persisted as AlertRow[]).map(alertToGql);
    },

    acknowledgeAlert: async (_p: unknown, args: { id: string }, ctx: ApolloContext) =>
      transition(args.id, 'ACKNOWLEDGED', ctx),

    dismissAlert: async (_p: unknown, args: { id: string }, ctx: ApolloContext) =>
      transition(args.id, 'DISMISSED', ctx),
  },
};

// Cambia el estado de una alerta (acknowledge/dismiss) con autorización y sello de gestión.
async function transition(id: string, status: 'ACKNOWLEDGED' | 'DISMISSED', ctx: ApolloContext) {
  const actor = requireAuth(ctx.user);
  const a = await prisma.alert.findUnique({ where: { id }, include: { supply: true } });
  if (!a) throw gqlError('ALERT_NOT_FOUND');
  assertSupplyAccess(actor, (a as unknown as { supply: { id: string; clientId: string } }).supply);
  assertCanWritePreInvoice(actor);

  const updated = await prisma.alert.update({
    where: { id },
    data: { status, acknowledgedBy: actor.id, acknowledgedAt: new Date() },
  });
  return alertToGql(updated as unknown as AlertRow);
}
