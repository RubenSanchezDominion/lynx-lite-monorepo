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

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Formatea una fecha a 'YYYY/MM' (formato de rango que espera DATADIS).
function yyyymm(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Rango de backfill: 2 años hacia atrás desde `now` (inclusive mes actual).
export function backfillRange(now: Date): { startDate: string; endDate: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));
  return { startDate: yyyymm(start), endDate: yyyymm(now) };
}

export interface BackfillDeps {
  prisma: Pick<PrismaClient, 'supply'>;
  http: DatadisHttp;
  writeApi: WriteApi;
  // Opcional: si se provee, se imputan huecos tras la ingesta de consumo.
  queryApi?: QueryApi;
  now?: Date;
}

// Ejecuta el backfill de onboarding de un suministro (SPECS §1.5, TC-PRE-027):
//  - 2 años de hourly_consumption y max_power siempre.
//  - 2 años de monthly_reactive SOLO para 3.0TD.
//  - Actualiza backfillStatus: RUNNING → DONE | FAILED.
export async function runBackfill(supplyId: string, deps: BackfillDeps): Promise<void> {
  const { prisma, http, writeApi } = deps;
  const now = deps.now ?? new Date();

  const supply = await prisma.supply.findUnique({ where: { id: supplyId } });
  if (!supply) throw new Error(`Supply ${supplyId} no existe`);

  await prisma.supply.update({ where: { id: supplyId }, data: { backfillStatus: 'RUNNING' } });

  try {
    const { startDate, endDate } = backfillRange(now);
    const tariff = supply.tariff as Tariff;
    const distributorCode = (await fetchDistributorCode(http, supply.cups)) ?? '2';

    const consumptionPoints = await fetchConsumption(
      http,
      { cups: supply.cups, distributorCode, startDate, endDate, tariff },
      writeApi,
    );
    await fetchMaxPower(http, { cups: supply.cups, distributorCode, startDate, endDate }, writeApi);

    if (tariff === 'T_3_0TD') {
      await fetchReactive(http, { cups: supply.cups, distributorCode, startDate, endDate }, writeApi);
    }

    // Imputación de huecos del histórico (solo si hay queryApi y datos que imputar).
    if (deps.queryApi && consumptionPoints.length > 0) {
      const from = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));
      await imputeConsumptionGaps(
        {
          cups: supply.cups, tariff, from, to: now,
          present: new Set(consumptionPoints.map(p => p.timestamp.toISOString())),
          lookupPreviousWeek: makePreviousWeekLookup(deps.queryApi, bucket, supply.cups),
        },
        writeApi,
      );
    }

    writeApi.flush();
    await prisma.supply.update({ where: { id: supplyId }, data: { backfillStatus: 'DONE' } });
  } catch (err) {
    await prisma.supply.update({ where: { id: supplyId }, data: { backfillStatus: 'FAILED' } });
    throw err;
  }
}
