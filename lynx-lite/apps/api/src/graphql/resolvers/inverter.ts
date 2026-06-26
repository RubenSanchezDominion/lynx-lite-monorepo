import type { ApolloContext } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { gqlError } from '../../lib/errors.js';
import { requireAuth, assertSupplyAccess, assertCanWritePreInvoice } from '../../services/authz.js';
import { getInverterDataSource } from '../../services/runtime.js';
import {
  analyzeInverterUpload,
  detectInverterMapping,
  type AnalyzeInverterUploadInput,
} from '../../services/inverterService.js';

// M06.3 — producción FV real medida (ingesta de inversor). detectInverterMapping = lectura asistida;
// analyzeInverterUpload = análisis al vuelo (no persiste, §8.12).
export const inverterResolvers = {
  Query: {
    detectInverterMapping: async (
      _p: unknown,
      args: { input: { cups: string; sampleRows: string[][] } },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      return detectInverterMapping(args.input.sampleRows);
    },
  },

  Mutation: {
    analyzeInverterUpload: async (
      _p: unknown,
      args: { input: AnalyzeInverterUploadInput },
      ctx: ApolloContext,
    ) => {
      const actor = requireAuth(ctx.user);
      const supply = await prisma.supply.findUnique({ where: { cups: args.input.cups } });
      if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
      assertSupplyAccess(actor, supply);
      assertCanWritePreInvoice(actor); // USUARIO → FORBIDDEN
      return analyzeInverterUpload(args.input, { prisma, dataSource: getInverterDataSource() });
    },
  },
};
