import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../services/authz.js';
import { computeDashboard } from '../../services/dashboardService.js';

// SPECS §11 — query de solo lectura. El scope se deriva del usuario autenticado.
export const dashboardResolvers = {
  Query: {
    dashboard: async (_p: unknown, _args: unknown, ctx: ApolloContext) => {
      const actor = requireAuth(ctx.user);
      return computeDashboard(actor, prisma);
    },
  },
};
