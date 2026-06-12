import { authResolvers } from './auth.js';
import { supplyResolvers } from './supply.js';
import { preInvoiceResolvers } from './preInvoice.js';

export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...supplyResolvers.Query,
    ...preInvoiceResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...supplyResolvers.Mutation,
    ...preInvoiceResolvers.Mutation,
  },
};
