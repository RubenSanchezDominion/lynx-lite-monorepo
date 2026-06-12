import cron from 'node-cron';
import { createDatadisHttp } from '@lynx-lite/data-collector';
import { prisma } from '../lib/prisma.js';
import { writeApi, queryApi } from '../lib/influx.js';
import { makeConsumptionExists } from './influxQueries.js';
import {
  syncDailyConsumption,
  syncWeeklyMaxPower,
  syncMonthlyReactive,
  processPendingBackfills,
  type SyncDeps,
} from './scheduler.js';

const http = createDatadisHttp({
  baseUrl: process.env.DATADIS_URL ?? 'http://localhost:3001',
  nif: process.env.DATADIS_NIF ?? '12345678A',
  password: process.env.DATADIS_PASSWORD ?? 'mock-pass',
});

function deps(): SyncDeps {
  return {
    prisma,
    http,
    writeApi,
    queryApi,
    consumptionExists: makeConsumptionExists(queryApi),
  };
}

function safe(name: string, fn: () => Promise<void>) {
  fn().catch((err) => console.error(`[worker] job ${name} falló:`, err));
}

// ─── Programación de jobs (SPECS §1.5) ─────────────────────────────────────────
// Diario 06:00 — curvas de consumo D-2
cron.schedule('0 6 * * *', () => safe('daily-consumption', () => syncDailyConsumption(deps())));
// Semanal lunes 06:00 — maxímetro
cron.schedule('0 6 * * 1', () => safe('weekly-maxpower', () => syncWeeklyMaxPower(deps())));
// Mensual día 5 06:00 — reactiva (3.0TD)
cron.schedule('0 6 5 * *', () => safe('monthly-reactive', () => syncMonthlyReactive(deps())));
// Poller de backfills PENDING — cada minuto
cron.schedule('* * * * *', () => safe('pending-backfills', () => processPendingBackfills(deps())));

console.log('[worker] scheduler arrancado — jobs: diario 06:00, lunes, día 5; poller backfill cada minuto');

// Cierre limpio.
process.on('SIGINT', async () => {
  await writeApi.close().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
});
