import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess } from '../../services/authz.js';
import { getDataSource, getIngestion } from '../../services/runtime.js';
import { computeComparison } from '../../services/comparisonService.js';
import { computedToGql } from './preInvoice.js';

type SideInput = { cups: string; periodFrom: string; periodTo: string };

// M07 — Comparativa de suministros. Operación de LECTURA: calcula dos pre-facturas
// (sin persistir) y devuelve los deltas. Verifica acceso a AMBOS suministros.
export const comparisonResolvers = {
  Query: {
    calculateComparison: async (
      _p: unknown,
      args: { input: { a: SideInput; b: SideInput } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);

      // Autorización: ambos CUPS deben existir y ser accesibles antes de calcular.
      for (const side of [args.input.a, args.input.b]) {
        const supply = await prisma.supply.findUnique({ where: { cups: side.cups } });
        if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
        assertSupplyAccess(actor, supply);
      }

      const result = await computeComparison(args.input, {
        prisma,
        dataSource: getDataSource(),
        ensureData: getIngestion(),
      });

      return {
        a: computedToGql(result.a),
        b: computedToGql(result.b),
        delta: result.delta,
      };
    },
  },
};
