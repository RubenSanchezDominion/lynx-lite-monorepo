import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getDataSource, getIngestion } from '../../services/runtime.js';
import { computePreInvoice, type ComputedPreInvoice } from '../../services/preInvoiceService.js';
import type { PreInvoiceLine } from '@prisma/client';

// Mapea el resultado de cálculo al tipo GraphQL PreInvoice (sin persistir).
// Exportado para reutilizar en la comparativa (M07).
export function computedToGql(c: ComputedPreInvoice) {
  const p = c.pricing;
  return {
    id: 'preview', // no persistido
    supplyId: c.supply.id,
    periodFrom: c.periodFrom.toISOString().slice(0, 10),
    periodTo: c.periodTo.toISOString().slice(0, 10),
    tariff: c.tariff,
    powerTerm: p.powerTerm,
    energyTerm: p.energyTerm,
    excessPower: p.excessPower,
    reactiveEnergy: c.reactiveApplied ? p.reactiveEnergy : null,
    surplusCompensation: p.surplusCompensation || null,
    meterRental: p.meterRental,
    subtotal: p.subtotal,
    ieeAmount: p.ieeAmount,
    vatAmount: p.vatAmount,
    total: p.total,
    gapHoursCount: c.gapHoursCount,
    gapPeriodsJson: c.gapPeriodsJson ? JSON.stringify(c.gapPeriodsJson) : null,
    lines: p.lines.map(l => ({
      concept: l.concept,
      period: l.period,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
      sortOrder: l.sortOrder,
    })),
    createdAt: new Date(0).toISOString(),
  };
}

// Mapea un registro persistido (con líneas) al tipo GraphQL.
function persistedToGql(pi: {
  id: string;
  supplyId: string;
  periodFrom: Date;
  periodTo: Date;
  tariff: string;
  powerTerm: number;
  energyTerm: number;
  excessPower: number;
  reactiveEnergy: number | null;
  surplusCompensation: number | null;
  meterRental: number;
  subtotal: number;
  ieeAmount: number;
  vatAmount: number;
  total: number;
  gapHoursCount: number;
  gapPeriodsJson: unknown;
  createdAt: Date;
  lines: PreInvoiceLine[];
}) {
  return {
    id: pi.id,
    supplyId: pi.supplyId,
    periodFrom: pi.periodFrom.toISOString().slice(0, 10),
    periodTo: pi.periodTo.toISOString().slice(0, 10),
    tariff: pi.tariff,
    powerTerm: pi.powerTerm,
    energyTerm: pi.energyTerm,
    excessPower: pi.excessPower,
    reactiveEnergy: pi.reactiveEnergy,
    surplusCompensation: pi.surplusCompensation,
    meterRental: pi.meterRental,
    subtotal: pi.subtotal,
    ieeAmount: pi.ieeAmount,
    vatAmount: pi.vatAmount,
    total: pi.total,
    gapHoursCount: pi.gapHoursCount,
    gapPeriodsJson: pi.gapPeriodsJson ? JSON.stringify(pi.gapPeriodsJson) : null,
    lines: [...pi.lines]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(l => ({
        concept: l.concept,
        period: l.period,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        amount: l.amount,
        sortOrder: l.sortOrder,
      })),
    createdAt: pi.createdAt.toISOString(),
  };
}

export const preInvoiceResolvers = {
  Query: {
    calculatePreInvoice: async (
      _p: unknown,
      args: { input: { cups: string; periodFrom: string; periodTo: string } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);

      // Autorización: cargar supply y verificar acceso antes de calcular.
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const computed = await computePreInvoice(args.input, {
        prisma,
        dataSource: getDataSource(),
        ensureData: getIngestion(),
      });
      return computedToGql(computed);
    },

    preInvoice: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const pi = await prisma.preInvoice.findUnique({
        where: { id: args.id },
        include: { lines: true, supply: true },
      });
      if (!pi) return null;
      assertSupplyAccess(actor, pi.supply);
      return persistedToGql(pi);
    },

    preInvoices: async (
      _p: unknown,
      args: { supplyId: string; limit?: number; offset?: number },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);

      const list = await prisma.preInvoice.findMany({
        where: { supplyId: args.supplyId },
        include: { lines: true },
        orderBy: { periodFrom: 'desc' },
        take: args.limit ?? 50,
        skip: args.offset ?? 0,
      });
      return list.map(persistedToGql);
    },
  },

  Mutation: {
    savePreInvoice: async (
      _p: unknown,
      args: { input: { cups: string; periodFrom: string; periodTo: string } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);

      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN (TC-AUTH-005)

      const computed = await computePreInvoice(args.input, {
        prisma,
        dataSource: getDataSource(),
        ensureData: getIngestion(),
      });

      const p = computed.pricing;

      // Idempotente por (supplyId, periodFrom, periodTo) — TC-PRE-007.
      const existing = await prisma.preInvoice.findUnique({
        where: {
          supplyId_periodFrom_periodTo: {
            supplyId: computed.supply.id,
            periodFrom: computed.periodFrom,
            periodTo: computed.periodTo,
          },
        },
        include: { lines: true },
      });

      if (existing) {
        // Reemplaza líneas y campos (recalcula con datos actuales).
        await prisma.preInvoiceLine.deleteMany({ where: { preInvoiceId: existing.id } });
        const updated = await prisma.preInvoice.update({
          where: { id: existing.id },
          data: {
            tariff: computed.tariff,
            powerTerm: p.powerTerm,
            energyTerm: p.energyTerm,
            excessPower: p.excessPower,
            reactiveEnergy: computed.reactiveApplied ? p.reactiveEnergy : null,
            surplusCompensation: p.surplusCompensation || null,
            meterRental: p.meterRental,
            subtotal: p.subtotal,
            ieeAmount: p.ieeAmount,
            vatAmount: p.vatAmount,
            total: p.total,
            gapHoursCount: computed.gapHoursCount,
            gapPeriodsJson: computed.gapPeriodsJson ?? undefined,
            lines: { create: p.lines },
          },
          include: { lines: true },
        });
        return persistedToGql(updated);
      }

      const created = await prisma.preInvoice.create({
        data: {
          supplyId: computed.supply.id,
          periodFrom: computed.periodFrom,
          periodTo: computed.periodTo,
          tariff: computed.tariff,
          powerTerm: p.powerTerm,
          energyTerm: p.energyTerm,
          excessPower: p.excessPower,
          reactiveEnergy: computed.reactiveApplied ? p.reactiveEnergy : null,
          surplusCompensation: p.surplusCompensation || null,
          meterRental: p.meterRental,
          subtotal: p.subtotal,
          ieeAmount: p.ieeAmount,
          vatAmount: p.vatAmount,
          total: p.total,
          gapHoursCount: computed.gapHoursCount,
          gapPeriodsJson: computed.gapPeriodsJson ?? undefined,
          lines: { create: p.lines },
        },
        include: { lines: true },
      });
      return persistedToGql(created);
    },

    deletePreInvoice: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const pi = await prisma.preInvoice.findUnique({
        where: { id: args.id },
        include: { supply: true },
      });
      if (!pi) return false;
      assertSupplyAccess(actor, pi.supply);
      assertCanWritePreInvoice(actor);

      await prisma.preInvoiceLine.deleteMany({ where: { preInvoiceId: args.id } });
      await prisma.preInvoice.delete({ where: { id: args.id } });
      return true;
    },
  },
};
