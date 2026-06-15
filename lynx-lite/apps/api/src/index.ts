import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers/index.js';
import { buildContext, type ApolloContext } from './context.js';
import { setDataSource, setIngestion, setOptimizationDataSource } from './services/runtime.js';
import { makeInfluxDataSource } from './services/preInvoiceData.js';
import { makeInfluxOptimizationDataSource } from './services/powerOptimizationData.js';
import { makeOnDemandIngestion, makeConsumptionCoverage } from './services/ingestion.js';
import { createDatadisHttp, createEsiosHttp } from '@lynx-lite/data-collector';
import { queryApi, writeApi } from './lib/influx.js';

async function main() {
  // Inicializa los DataSources reales (InfluxDB) antes de servir.
  setDataSource(makeInfluxDataSource(queryApi));
  setOptimizationDataSource(makeInfluxOptimizationDataSource(queryApi));

  // Ingesta on-demand (anti-429): comprueba cobertura en InfluxDB antes de llamar a DATADIS.
  const datadis = createDatadisHttp({
    baseUrl: process.env.DATADIS_URL ?? 'http://localhost:3001',
    nif: process.env.DATADIS_NIF ?? '12345678A',
    password: process.env.DATADIS_PASSWORD ?? 'mock-pass',
  });
  const esios = createEsiosHttp({
    baseUrl: process.env.ESIOS_URL ?? 'http://localhost:3003',
    apiKey: process.env.ESIOS_API_KEY ?? 'mock-key',
  });
  setIngestion(makeOnDemandIngestion({
    hasCoverage: makeConsumptionCoverage(queryApi),
    datadis,
    esios,
    writeApi,
    queryApi,
  }));

  const server = new ApolloServer<ApolloContext>({ typeDefs, resolvers });
  await server.start();

  const app = express();
  app.use(
    '/graphql',
    express.json(),
    expressMiddleware(server, { context: buildContext }),
  );

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`[api] GraphQL en http://localhost:${port}/graphql`);
  });
}

main().catch((err) => {
  console.error('[api] fallo al arrancar:', err);
  process.exit(1);
});
