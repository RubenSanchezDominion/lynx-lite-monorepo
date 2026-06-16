import { authResolvers } from './auth.js';
import { supplyResolvers } from './supply.js';
import { preInvoiceResolvers } from './preInvoice.js';
import { powerOptimizationResolvers } from './powerOptimization.js';
import { alertResolvers } from './alert.js';

export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...supplyResolvers.Query,
    ...preInvoiceResolvers.Query,
    ...powerOptimizationResolvers.Query,
    ...alertResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...supplyResolvers.Mutation,
    ...preInvoiceResolvers.Mutation,
    ...powerOptimizationResolvers.Mutation,
    ...alertResolvers.Mutation,
  },
};
