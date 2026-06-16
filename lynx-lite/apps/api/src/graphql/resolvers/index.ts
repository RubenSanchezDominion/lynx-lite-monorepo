import { authResolvers } from './auth.js';
import { supplyResolvers } from './supply.js';
import { preInvoiceResolvers } from './preInvoice.js';
import { powerOptimizationResolvers } from './powerOptimization.js';
import { alertResolvers } from './alert.js';
import { kpiResolvers } from './kpi.js';
import { carbonResolvers } from './carbon.js';

export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...supplyResolvers.Query,
    ...preInvoiceResolvers.Query,
    ...powerOptimizationResolvers.Query,
    ...alertResolvers.Query,
    ...kpiResolvers.Query,
    ...carbonResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...supplyResolvers.Mutation,
    ...preInvoiceResolvers.Mutation,
    ...powerOptimizationResolvers.Mutation,
    ...alertResolvers.Mutation,
    ...kpiResolvers.Mutation,
    ...carbonResolvers.Mutation,
  },
};
