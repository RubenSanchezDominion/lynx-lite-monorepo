import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getSolarDataSource } from '../../services/runtime.js';
import {
  simulateSolarForSupply,
  optimizeSolarSizingForSupply,
  optimizeSolarOrientationForSupply,
  type SimulateSolarInput,
  type OptimizeSolarSizingInput,
  type OptimizeSolarOrientationInput,
} from '../../services/solarService.js';

interface SimRow {
  id: string;
  supplyId: string;
  lat: number;
  lon: number;
  kwp: number;
  lossPct: number;
  tilt: number;
  azimuth: number;
  costPerKwp: number;
  rangeStart: Date;
  rangeEnd: Date;
  annualProductionKwh: number;
  monthlyProductionJson: string;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number;
  coverageRatio: number;
  annualSavingEur: number;
  paybackYears: number | null;
  computedAt: Date;
}

interface MonthJson {
  key: string;
  monthStart: string;
  productionKwh: number;
  selfConsumptionKwh: number;
  surplusKwh: number;
}

function simToGql(r: SimRow) {
  const months = (JSON.parse(r.monthlyProductionJson || '[]') as MonthJson[]).map(m => ({
    monthKey: m.key,
    monthStart: m.monthStart,
    productionKwh: m.productionKwh,
    selfConsumptionKwh: m.selfConsumptionKwh,
    surplusKwh: m.surplusKwh,
  }));
  return {
    id: r.id,
    supplyId: r.supplyId,
    lat: r.lat,
    lon: r.lon,
    kwp: r.kwp,
    lossPct: r.lossPct,
    tilt: r.tilt,
    azimuth: r.azimuth,
    costPerKwp: r.costPerKwp,
    rangeStart: r.rangeStart.toISOString(),
    rangeEnd: r.rangeEnd.toISOString(),
    annualProductionKwh: r.annualProductionKwh,
    annualSelfConsumptionKwh: r.annualSelfConsumptionKwh,
    annualSurplusKwh: r.annualSurplusKwh,
    selfConsumptionRatio: r.selfConsumptionRatio,
    coverageRatio: r.coverageRatio,
    annualSavingEur: r.annualSavingEur,
    paybackYears: r.paybackYears ?? null,
    computedAt: r.computedAt.toISOString(),
    months,
  };
}

export const solarResolvers = {
  Query: {
    solarSimulation: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const r = await prisma.solarSimulation.findUnique({
        where: { id: args.id },
        include: { supply: true },
      });
      if (!r) return null;
      assertSupplyAccess(actor, (r as unknown as { supply: { id: string; clientId: string } }).supply);
      return simToGql(r as unknown as SimRow);
    },

    solarSimulations: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = (await prisma.solarSimulation.findMany({
        where: { supplyId: args.supplyId },
        orderBy: { computedAt: 'desc' },
      })) as SimRow[];
      return list.map(simToGql);
    },

    // §8.10 — dimensionado óptimo (no persiste). El resultado del engine ya tiene el shape del SDL.
    optimizeSolarSizing: async (_p: unknown, args: { input: OptimizeSolarSizingInput }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN
      return optimizeSolarSizingForSupply(args.input, { prisma, dataSource: getSolarDataSource() });
    },

    // §8.11 — orientación óptima (no persiste).
    optimizeSolarOrientation: async (_p: unknown, args: { input: OptimizeSolarOrientationInput }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN
      return optimizeSolarOrientationForSupply(args.input, { prisma, dataSource: getSolarDataSource() });
    },
  },

  Mutation: {
    simulateSolar: async (_p: unknown, args: { input: SimulateSolarInput }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN

      const sim = await simulateSolarForSupply(args.input, { prisma, dataSource: getSolarDataSource() });
      return simToGql(sim as SimRow);
    },
  },
};
