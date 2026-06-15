import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getOptimizationDataSource } from '../../services/runtime.js';
import {
  computePowerOptimization,
  type ComputedPowerOptimization,
} from '../../services/powerOptimizationService.js';
import type { PowerOptimizationPeriod } from '@prisma/client';

// Mapea el resultado de cálculo al tipo GraphQL (sin persistir).
function computedToGql(c: ComputedPowerOptimization) {
  const r = c.result;
  return {
    id: 'preview', // no persistido
    supplyId: c.supply.id,
    tariff: c.tariff,
    analysisFrom: c.analysisFrom.toISOString().slice(0, 10),
    analysisTo: c.analysisTo.toISOString().slice(0, 10),
    granularity: c.granularity,
    upliftFactor: r.upliftFactor,
    sampleCount: r.sampleCount,
    fixedSaving: r.fixedSaving,
    excessSaving: r.excessSaving,
    annualSaving: r.annualSaving,
    recommendChange: r.recommendChange,
    changeAllowed: r.changeAllowed,
    changeBlockedUntil: r.changeBlockedUntil,
    periods: r.periods.map(p => ({ ...p })),
    createdAt: new Date(0).toISOString(),
  };
}

// Datos de persistencia que comparten create/update.
function persistData(c: ComputedPowerOptimization) {
  const r = c.result;
  return {
    tariff: c.tariff,
    analysisFrom: c.analysisFrom,
    analysisTo: c.analysisTo,
    granularity: c.granularity,
    upliftFactor: r.upliftFactor,
    sampleCount: r.sampleCount,
    fixedSaving: r.fixedSaving,
    excessSaving: r.excessSaving,
    annualSaving: r.annualSaving,
    recommendChange: r.recommendChange,
    changeAllowed: r.changeAllowed,
    changeBlockedUntil: r.changeBlockedUntil ? new Date(r.changeBlockedUntil) : null,
  };
}

function persistedToGql(o: {
  id: string;
  supplyId: string;
  tariff: string;
  analysisFrom: Date;
  analysisTo: Date;
  granularity: string;
  upliftFactor: number;
  sampleCount: number;
  fixedSaving: number;
  excessSaving: number;
  annualSaving: number;
  recommendChange: boolean;
  changeAllowed: boolean;
  changeBlockedUntil: Date | null;
  createdAt: Date;
  periods: PowerOptimizationPeriod[];
}) {
  return {
    id: o.id,
    supplyId: o.supplyId,
    tariff: o.tariff,
    analysisFrom: o.analysisFrom.toISOString().slice(0, 10),
    analysisTo: o.analysisTo.toISOString().slice(0, 10),
    granularity: o.granularity,
    upliftFactor: o.upliftFactor,
    sampleCount: o.sampleCount,
    fixedSaving: o.fixedSaving,
    excessSaving: o.excessSaving,
    annualSaving: o.annualSaving,
    recommendChange: o.recommendChange,
    changeAllowed: o.changeAllowed,
    changeBlockedUntil: o.changeBlockedUntil ? o.changeBlockedUntil.toISOString().slice(0, 10) : null,
    periods: [...o.periods]
      .sort((a, b) => a.period - b.period)
      .map(p => ({
        period: p.period,
        currentPower: p.currentPower,
        optimalPower: p.optimalPower,
        p99Power: p.p99Power,
        observedMax: p.observedMax,
        diagnosis: p.diagnosis,
        marginPct: p.marginPct,
      })),
    createdAt: o.createdAt.toISOString(),
  };
}

export const powerOptimizationResolvers = {
  Query: {
    calculatePowerOptimization: async (
      _p: unknown,
      args: { input: { cups: string; analysisFrom: string; analysisTo: string } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const computed = await computePowerOptimization(args.input, {
        prisma,
        dataSource: getOptimizationDataSource(),
      });
      return computedToGql(computed);
    },

    powerOptimization: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const o = await prisma.powerOptimization.findUnique({
        where: { id: args.id },
        include: { periods: true, supply: true },
      });
      if (!o) return null;
      assertSupplyAccess(actor, o.supply);
      return persistedToGql(o);
    },

    powerOptimizations: async (
      _p: unknown,
      args: { supplyId: string; limit?: number; offset?: number },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = await prisma.powerOptimization.findMany({
        where: { supplyId: args.supplyId },
        include: { periods: true },
        orderBy: { analysisTo: 'desc' },
        take: args.limit ?? 50,
        skip: args.offset ?? 0,
      });
      return list.map(persistedToGql);
    },
  },

  Mutation: {
    savePowerOptimization: async (
      _p: unknown,
      args: { input: { cups: string; analysisFrom: string; analysisTo: string } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN

      const computed = await computePowerOptimization(args.input, {
        prisma,
        dataSource: getOptimizationDataSource(),
      });
      const data = persistData(computed);
      const periodsCreate = computed.result.periods.map(p => ({
        period: p.period,
        currentPower: p.currentPower,
        optimalPower: p.optimalPower,
        p99Power: p.p99Power,
        observedMax: p.observedMax,
        diagnosis: p.diagnosis,
        marginPct: p.marginPct,
      }));

      // Idempotente por (supplyId, analysisFrom, analysisTo).
      const existing = await prisma.powerOptimization.findUnique({
        where: {
          supplyId_analysisFrom_analysisTo: {
            supplyId: computed.supply.id,
            analysisFrom: computed.analysisFrom,
            analysisTo: computed.analysisTo,
          },
        },
      });

      if (existing) {
        await prisma.powerOptimizationPeriod.deleteMany({
          where: { optimizationId: existing.id },
        });
        const updated = await prisma.powerOptimization.update({
          where: { id: existing.id },
          data: { ...data, periods: { create: periodsCreate } },
          include: { periods: true },
        });
        return persistedToGql(updated);
      }

      const created = await prisma.powerOptimization.create({
        data: { supplyId: computed.supply.id, ...data, periods: { create: periodsCreate } },
        include: { periods: true },
      });
      return persistedToGql(created);
    },

    deletePowerOptimization: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const o = await prisma.powerOptimization.findUnique({
        where: { id: args.id },
        include: { supply: true },
      });
      if (!o) return false;
      assertSupplyAccess(actor, o.supply);
      assertCanWritePreInvoice(actor);

      await prisma.powerOptimizationPeriod.deleteMany({ where: { optimizationId: args.id } });
      await prisma.powerOptimization.delete({ where: { id: args.id } });
      return true;
    },
  },
};
