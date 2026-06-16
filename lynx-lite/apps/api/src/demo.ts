import express from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers/index.js';
import { buildContext, type ApolloContext } from './context.js';
import { setPrisma } from './lib/prisma.js';
import { setDataSource, setOptimizationDataSource, setAlertDataSource } from './services/runtime.js';
import { createInMemoryStore } from './demo/store.js';
import { makeDemoDataSource } from './demo/demoDataSource.js';
import { makeDemoOptimizationDataSource } from './demo/demoOptimizationDataSource.js';
import { makeDemoAlertDataSource } from './demo/demoAlertDataSource.js';

// Bootstrap del MODO DEMO: GraphQL real con datos en memoria (sin Postgres ni InfluxDB).
// El motor de cálculo es el real; solo cambian los orígenes de datos.
async function main() {
  const store = await createInMemoryStore();
  setPrisma(store); // inyecta el store en memoria en lugar del PrismaClient real
  setDataSource(makeDemoDataSource()); // series temporales sintéticas
  setOptimizationDataSource(makeDemoOptimizationDataSource()); // curva sintética para M02
  setAlertDataSource(makeDemoAlertDataSource()); // curva con anomalías sembradas para M03
  // No se inyecta ingesta: los datos del demo se consideran "ya disponibles".

  const server = new ApolloServer<ApolloContext>({ typeDefs, resolvers });
  await server.start();

  const app = express();
  app.use(
    '/graphql',
    cors(), // permite el origen del dev server de Angular (localhost:4200)
    express.json(),
    expressMiddleware(server, { context: buildContext }),
  );

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`[api:demo] GraphQL (modo memoria) en http://localhost:${port}/graphql`);
    console.log('[api:demo] login demo: dominion@lynx.local / dominion  ·  admin@pyme.local / admin');
    console.log('[api:demo] CUPS sembrados: ES0031000000000002JN (2.0TD) · ES0031000000000001JN (3.0TD)');
  });
}

main().catch((err) => {
  console.error('[api:demo] fallo al arrancar:', err);
  process.exit(1);
});
