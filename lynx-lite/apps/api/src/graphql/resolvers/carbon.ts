import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getCarbonDataSource, getCo2Ingestion } from '../../services/runtime.js';
import { runCarbonComputation, persistCarbonReport, type ComputeCarbonInput } from '../../services/carbonService.js';

interface ReportLineRow {
  monthKey: string;
  monthStart: Date;
  kwh: number;
  co2Kg: number;
  factorAvg: number;
  hasGaps: boolean;
}

interface ReportRow {
  id: string;
  supplyId: string;
  rangeStart: Date;
  rangeEnd: Date;
  totalKwh: number;
  totalCo2Kg: number;
  ownFactorGPerKwh: number;
  nationalAvgFactor: number;
  deltaPct: number;
  hasGaps: boolean;
  computedAt: Date;
  lines: ReportLineRow[];
}

function reportToGql(r: ReportRow) {
  return {
    id: r.id,
    supplyId: r.supplyId,
    rangeStart: r.rangeStart.toISOString(),
    rangeEnd: r.rangeEnd.toISOString(),
    totalKwh: r.totalKwh,
    totalCo2Kg: r.totalCo2Kg,
    ownFactorGPerKwh: r.ownFactorGPerKwh,
    nationalAvgFactor: r.nationalAvgFactor,
    deltaPct: r.deltaPct,
    hasGaps: r.hasGaps,
    computedAt: r.computedAt.toISOString(),
    lines: [...r.lines]
      .sort((a, b) => a.monthStart.getTime() - b.monthStart.getTime())
      .map(l => ({
        monthKey: l.monthKey,
        monthStart: l.monthStart.toISOString(),
        kwh: l.kwh,
        co2Kg: l.co2Kg,
        factorAvg: l.factorAvg,
        hasGaps: l.hasGaps,
      })),
  };
}

export const carbonResolvers = {
  Query: {
    carbonReport: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const r = await prisma.carbonReport.findUnique({
        where: { id: args.id },
        include: { lines: true, supply: true },
      });
      if (!r) return null;
      assertSupplyAccess(actor, (r as unknown as { supply: { id: string; clientId: string } }).supply);
      return reportToGql(r as unknown as ReportRow);
    },

    carbonReports: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = (await prisma.carbonReport.findMany({
        where: { supplyId: args.supplyId },
        orderBy: { computedAt: 'desc' },
        include: { lines: true },
      })) as ReportRow[];
      return list.map(reportToGql);
    },
  },

  Mutation: {
    computeCarbonFootprint: async (_p: unknown, args: { input: ComputeCarbonInput }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN

      const computed = await runCarbonComputation(args.input, {
        prisma,
        dataSource: getCarbonDataSource(),
        ingestion: getCo2Ingestion(),
      });
      const report = await persistCarbonReport(computed, prisma);
      return reportToGql(report as ReportRow);
    },
  },
};
