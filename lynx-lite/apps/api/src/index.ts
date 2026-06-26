import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers/index.js';
import { buildContext, type ApolloContext } from './context.js';
import { setDataSource, setIngestion, setOptimizationDataSource, setAlertDataSource, setKpiDataSource, setCarbonDataSource, setCo2Ingestion, setSolarDataSource, setInverterDataSource } from './services/runtime.js';
import { makeInfluxDataSource } from './services/preInvoiceData.js';
import { makeInfluxOptimizationDataSource } from './services/powerOptimizationData.js';
import { makeInfluxAlertDataSource } from './services/alertData.js';
import { makeInfluxKpiDataSource } from './services/kpiData.js';
import { makeInfluxCarbonDataSource } from './services/carbonData.js';
import { makeInfluxSolarDataSource } from './services/solarData.js';
import { makeInfluxInverterDataSource } from './services/inverterData.js';
import { makeOnDemandIngestion, makeConsumptionCoverage } from './services/ingestion.js';
import { makeOnDemandCo2Ingestion, makeCo2Coverage } from './services/carbonIngestion.js';
import { createDatadisHttp, createEsiosHttp, createRedataHttp, createPvgisHttp, EMISSION_COEFFICIENTS } from '@lynx-lite/data-collector';
import { queryApi, writeApi } from './lib/influx.js';

async function main() {
  // Inicializa los DataSources reales (InfluxDB) antes de servir.
  setDataSource(makeInfluxDataSource(queryApi));
  setOptimizationDataSource(makeInfluxOptimizationDataSource(queryApi));
  setAlertDataSource(makeInfluxAlertDataSource(queryApi));
  setKpiDataSource(makeInfluxKpiDataSource(queryApi));
  setCarbonDataSource(makeInfluxCarbonDataSource(queryApi));
  const pvgis = createPvgisHttp({ baseUrl: process.env.PVGIS_URL ?? 'http://localhost:3004' });
  setSolarDataSource(makeInfluxSolarDataSource(queryApi, pvgis));
  // M06.3: lectura de consumo/PVPC + baseline PVGIS; persistencia de la serie medida LATENTE (Fase 1).
  setInverterDataSource(makeInfluxInverterDataSource(queryApi, pvgis));

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

  // Ingesta on-demand del factor de emisión (M05): compone co2_factor desde el mix de REData.
  const redata = createRedataHttp({ baseUrl: process.env.REDATA_URL ?? 'http://localhost:3002' });
  setCo2Ingestion(makeOnDemandCo2Ingestion({
    hasCoverage: makeCo2Coverage(queryApi),
    redata,
    coeffs: EMISSION_COEFFICIENTS,
    writeApi,
  }));

  const server = new ApolloServer<ApolloContext>({ typeDefs, resolvers });
  await server.start();

  const app = express();
  app.use(
    '/graphql',
    express.json({ limit: '50mb' }), // M06.3 sube el CSV crudo del inversor en el body (un año 15-min son MBs)
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
