import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError, forbidden } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess } from '../../services/authz.js';
import { enqueueBackfill } from '../../services/backfillTrigger.js';
import type { Tariff } from '@prisma/client';

function toGqlSupply(s: {
  id: string;
  cups: string;
  clientId: string;
  address: string | null;
  tariff: Tariff;
  backfillStatus: string;
  createdAt: Date;
}) {
  return {
    id: s.id,
    cups: s.cups,
    clientId: s.clientId,
    address: s.address,
    tariff: s.tariff,
    backfillStatus: s.backfillStatus,
    createdAt: s.createdAt.toISOString(),
  };
}

export const supplyResolvers = {
  Query: {
    supply: async (_p: unknown, args: { id: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { id: args.id } });
      if (!supply) return null;
      assertSupplyAccess(actor, supply);
      return toGqlSupply(supply);
    },
  },

  Mutation: {
    // Crea el suministro y lanza el backfill de 2 años en background.
    createSupply: async (
      _p: unknown,
      args: { input: { cups: string; clientId: string; address?: string; tariff: Tariff } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const { input } = args;

      // DOMINION crea en cualquier cliente; ADMIN solo en el suyo (§2.2).
      if (actor.role === 'ADMIN') {
        if (input.clientId !== actor.clientId) throw forbidden();
      } else if (actor.role !== 'DOMINION') {
        throw forbidden();
      }

      const supply = await prisma.supply.create({
        data: {
          cups: input.cups,
          clientId: input.clientId,
          address: input.address ?? null,
          tariff: input.tariff,
          backfillStatus: 'PENDING',
        },
      });

      // Dispara backfill sin esperar (retorna inmediatamente, TC-PRE-011).
      await enqueueBackfill(supply.id);

      return toGqlSupply(supply);
    },

    // ADMIN solicita nuevo supply → PENDING_APPROVAL hasta que DOMINION lo apruebe.
    requestSupply: async (
      _p: unknown,
      args: { cups: string; address?: string; tariff: Tariff },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      if (actor.role !== 'ADMIN' && actor.role !== 'DOMINION') throw forbidden();
      if (!actor.clientId && actor.role === 'ADMIN') throw forbidden();

      const supply = await prisma.supply.create({
        data: {
          cups: args.cups,
          clientId: actor.clientId!,
          address: args.address ?? null,
          tariff: args.tariff,
          status: 'PENDING_APPROVAL',
          requestedBy: actor.id,
          backfillStatus: 'PENDING',
        },
      });
      return toGqlSupply(supply);
    },

    // Solo DOMINION aprueba.
    approveSupply: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      if (actor.role !== 'DOMINION') throw forbidden();

      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');

      const updated = await prisma.supply.update({
        where: { id: args.supplyId },
        data: { status: 'ACTIVE' },
      });

      // Tras aprobar, lanza el backfill.
      await enqueueBackfill(updated.id);

      return toGqlSupply(updated);
    },

    rejectSupply: async (_p: unknown, args: { supplyId: string }, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      if (actor.role !== 'DOMINION') throw forbidden();

      const supply = await prisma.supply.findUnique({ where: { id: args.supplyId } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');

      await prisma.supply.delete({ where: { id: args.supplyId } });
      return true;
    },
  },
};
