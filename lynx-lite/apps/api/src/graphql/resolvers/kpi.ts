import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getKpiDataSource } from '../../services/runtime.js';
import {
  submitProduction,
  runKpiComputation,
  persistKpiReport,
  type ProductionRowInput,
} from '../../services/kpiService.js';

interface UploadRow {
  id: string;
  supplyId: string;
  fileName: string;
  format: string;
  rowCount: number;
  rangeStart: Date;
  rangeEnd: Date;
  uploadedAt: Date;
}

interface ReportLineRow {
  bucketKey: string;
  bucketStart: Date;
  units: number;
  kwh: number;
  costEur: number;
  eurPerUnit: number;
  isOutlier: boolean;
}

interface ReportRow {
  id: string;
  supplyId: string;
  uploadId: string;
  granularity: string;
  rangeStart: Date;
  rangeEnd: Date;
  totalUnits: number;
  totalKwh: number;
  totalCostEur: number;
  avgEurPerUnit: number;
  baselineEurPerUnit: number;
  outlierPct: number;
  hasGaps: boolean;
  computedAt: Date;
  lines: ReportLineRow[];
}

function uploadToGql(u: UploadRow) {
  return {
    id: u.id,
    supplyId: u.supplyId,
    fileName: u.fileName,
    format: u.format,
    rowCount: u.rowCount,
    rangeStart: u.rangeStart.toISOString(),
    rangeEnd: u.rangeEnd.toISOString(),
    uploadedAt: u.uploadedAt.toISOString(),
  };
}

function reportToGql(r: ReportRow) {
  return {
    id: r.id,
    supplyId: r.supplyId,
    uploadId: r.uploadId,
    granularity: r.granularity,
    rangeStart: r.rangeStart.toISOString(),
    rangeEnd: r.rangeEnd.toISOString(),
    totalUnits: r.totalUnits,
    totalKwh: r.totalKwh,
    totalCostEur: r.totalCostEur,
    avgEurPerUnit: r.avgEurPerUnit,
    baselineEurPerUnit: r.baselineEurPerUnit,
    outlierPct: r.outlierPct,
    hasGaps: r.hasGaps,
    computedAt: r.computedAt.toISOString(),
    lines: [...r.lines]
      .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
      .map(l => ({
        bucketKey: l.bucketKey,
        bucketStart: l.bucketStart.toISOString(),
        units: l.units,
        kwh: l.kwh,
        costEur: l.costEur,
        eurPerUnit: l.eurPerUnit,
        isOutlier: l.isOutlier,
      })),
  };
}

export interface SubmitProductionGqlInput {
  cups: string;
  fileName: string;
  format: string;
  rows: ProductionRowInput[];
}

export const kpiResolvers = {
  Query: {
    productionUploads: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = (await prisma.productionUpload.findMany({
        where: { supplyId: args.supplyId },
        orderBy: { uploadedAt: 'desc' },
      })) as UploadRow[];
      return list.map(uploadToGql);
    },

    kpiReport: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const r = await prisma.kpiReport.findUnique({
        where: { id: args.id },
        include: { lines: true, supply: true },
      });
      if (!r) return null;
      assertSupplyAccess(actor, (r as unknown as { supply: { id: string; clientId: string } }).supply);
      return reportToGql(r as unknown as ReportRow);
    },

    kpiReports: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = (await prisma.kpiReport.findMany({
        where: { supplyId: args.supplyId },
        orderBy: { computedAt: 'desc' },
        include: { lines: true },
      })) as ReportRow[];
      return list.map(reportToGql);
    },
  },

  Mutation: {
    submitProductionData: async (
      _p: unknown,
      args: { input: SubmitProductionGqlInput },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN

      const upload = await submitProduction(args.input, { prisma, dataSource: getKpiDataSource() });
      const full = (await prisma.productionUpload.findUnique({ where: { id: upload.id } })) as UploadRow;
      return uploadToGql(full);
    },

    computeKpi: async (
      _p: unknown,
      args: { input: { uploadId: string; granularity?: string; outlierPct?: number } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      // Autorización antes de computar: carga ligera del upload para conocer su suministro.
      const upload = await prisma.productionUpload.findUnique({
        where: { id: args.input.uploadId },
        include: { supply: true },
      });
      if (!upload) throw gqlError('KPI_UPLOAD_NOT_FOUND');
      assertSupplyAccess(actor, (upload as unknown as { supply: { id: string; clientId: string } }).supply);
      assertCanWritePreInvoice(actor);

      const computed = await runKpiComputation(args.input, { prisma, dataSource: getKpiDataSource() });
      const report = await persistKpiReport(computed, prisma);
      return reportToGql(report as ReportRow);
    },
  },
};
