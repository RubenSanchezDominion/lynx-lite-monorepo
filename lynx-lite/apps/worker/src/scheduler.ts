import type { WriteApi, QueryApi } from '@influxdata/influxdb-client';
import {
  fetchConsumption,
  fetchMaxPower,
  fetchReactive,
  fetchDistributorCode,
  imputeConsumptionGaps,
  makePreviousWeekLookup,
  type DatadisHttp,
  type Tariff,
} from '@lynx-lite/data-collector';
import type { PrismaClient } from '@prisma/client';
import { runBackfill } from './backfill.js';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Comprueba si InfluxDB ya tiene datos de hourly_consumption para un CUPS en una fecha.
// Inyectable para test (TC-PRE-026): evita la llamada a DATADIS si ya hay datos.
export type ConsumptionExistsFn = (cups: string, dateUtc: Date) => Promise<boolean>;

export interface SyncDeps {
  prisma: Pick<PrismaClient, 'supply'>;
  http: DatadisHttp;
  writeApi: WriteApi;
  consumptionExists: ConsumptionExistsFn;
  // Opcional: si se provee, se imputan huecos tras la ingesta de consumo.
  queryApi?: QueryApi;
  now?: Date;
}

function yyyymm(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Job diario 06:00 — sincroniza curvas de consumo de D-2 (SPECS §1.5).
// Antes de llamar a DATADIS, comprueba en InfluxDB qué fechas ya existen (anti-429).
export async function syncDailyConsumption(deps: SyncDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const dMinus2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2));

  const supplies = await deps.prisma.supply.findMany({
    where: { backfillStatus: 'DONE' },
  });

  for (const supply of supplies) {
    const already = await deps.consumptionExists(supply.cups, dMinus2);
    if (already) continue; // ya cubierto: no llamamos a DATADIS

    const distributorCode = (await fetchDistributorCode(deps.http, supply.cups)) ?? '2';
    const month = yyyymm(dMinus2);
    const consumptionPoints = await fetchConsumption(
      deps.http,
      { cups: supply.cups, distributorCode, startDate: month, endDate: month, tariff: supply.tariff as Tariff },
      deps.writeApi,
    );

    // Imputa los huecos del día D-2 (solo si hay queryApi y datos que imputar).
    if (deps.queryApi && consumptionPoints.length > 0) {
      const dayEnd = new Date(dMinus2.getTime() + 24 * 3600 * 1000);
      await imputeConsumptionGaps(
        {
          cups: supply.cups, tariff: supply.tariff as Tariff, from: dMinus2, to: dayEnd,
          present: new Set(consumptionPoints.map(p => p.timestamp.toISOString())),
          lookupPreviousWeek: makePreviousWeekLookup(deps.queryApi, bucket, supply.cups),
        },
        deps.writeApi,
      );
    }
  }
  deps.writeApi.flush();
}

// Job semanal (lunes) — maxímetro (SPECS §1.5).
export async function syncWeeklyMaxPower(deps: SyncDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const month = yyyymm(now);
  const supplies = await deps.prisma.supply.findMany({ where: { backfillStatus: 'DONE' } });
  for (const supply of supplies) {
    const distributorCode = (await fetchDistributorCode(deps.http, supply.cups)) ?? '2';
    await fetchMaxPower(deps.http, { cups: supply.cups, distributorCode, startDate: month, endDate: month }, deps.writeApi);
  }
  deps.writeApi.flush();
}

// Job mensual (día 5) — reactiva del mes anterior, solo 3.0TD (SPECS §1.5).
export async function syncMonthlyReactive(deps: SyncDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = yyyymm(prevMonth);
  const supplies = await deps.prisma.supply.findMany({
    where: { backfillStatus: 'DONE', tariff: 'T_3_0TD' },
  });
  for (const supply of supplies) {
    const distributorCode = (await fetchDistributorCode(deps.http, supply.cups)) ?? '2';
    await fetchReactive(deps.http, { cups: supply.cups, distributorCode, startDate: month, endDate: month }, deps.writeApi);
  }
  deps.writeApi.flush();
}

// Poller de backfills PENDING — coordinación api↔worker vía PostgreSQL (SPECS §1.5).
export async function processPendingBackfills(deps: SyncDeps): Promise<void> {
  const pending = await deps.prisma.supply.findMany({ where: { backfillStatus: 'PENDING' } });
  for (const supply of pending) {
    await runBackfill(supply.id, {
      prisma: deps.prisma,
      http: deps.http,
      writeApi: deps.writeApi,
      queryApi: deps.queryApi,
      now: deps.now,
    });
  }
}
