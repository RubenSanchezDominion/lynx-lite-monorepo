import type { WriteApi, QueryApi } from '@influxdata/influxdb-client';
import {
  fetchConsumption,
  fetchMaxPower,
  fetchReactive,
  fetchDistributorCode,
  fetchPvpcPrices,
  imputeConsumptionGaps,
  makePreviousWeekLookup,
  type DatadisHttp,
  type EsiosHttp,
  type Tariff,
} from '@lynx-lite/data-collector';

// Firma de ingesta on-demand usada por el servicio de pre-factura.
export type EnsureData = (cups: string, from: Date, to: Date, tariff: Tariff) => Promise<void>;

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// ¿Hay datos de consumo facturable en InfluxDB para el rango? (cobertura simple:
// existe al menos un punto). Usado como gate anti-429.
export function makeConsumptionCoverage(queryApi: QueryApi) {
  return async (cups: string, from: Date, to: Date): Promise<boolean> => {
    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${from.toISOString()}, stop: ${to.toISOString()})
        |> filter(fn: (r) => r._measurement == "hourly_consumption" and r.cups == "${cups}")
        |> limit(n: 1)
    `;
    const rows = await queryApi.collectRows(flux);
    return rows.length > 0;
  };
}

export interface IngestionDeps {
  // ¿InfluxDB ya cubre el rango solicitado? Si true, NO se llama a DATADIS (anti-429).
  hasCoverage: (cups: string, from: Date, to: Date) => Promise<boolean>;
  datadis: DatadisHttp;
  esios: EsiosHttp;
  writeApi: WriteApi;
  // Necesario para la imputación de huecos (lookup del mismo slot 7 días antes).
  queryApi: QueryApi;
}

// Formatea a 'YYYY/MM' (rango de meses que esperan DATADIS y nuestros adaptadores).
function yyyymm(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Construye la función de ingesta on-demand (SPECS §1.4): antes de cualquier llamada
// a DATADIS comprueba la cobertura en InfluxDB; el dato se persiste inmediatamente.
export function makeOnDemandIngestion(deps: IngestionDeps): EnsureData {
  return async (cups, from, to, tariff) => {
    // Regla anti-429 (SPECS §1.5): si ya está en InfluxDB, no se llama a DATADIS.
    if (await deps.hasCoverage(cups, from, to)) return;

    const startDate = yyyymm(from);
    const endDate = yyyymm(to);
    const distributorCode = (await fetchDistributorCode(deps.datadis, cups)) ?? '2';

    const consumptionPoints = await fetchConsumption(
      deps.datadis,
      { cups, distributorCode, startDate, endDate, tariff },
      deps.writeApi,
    );
    await fetchMaxPower(deps.datadis, { cups, distributorCode, startDate, endDate }, deps.writeApi);
    if (tariff === 'T_3_0TD') {
      await fetchReactive(deps.datadis, { cups, distributorCode, startDate, endDate }, deps.writeApi);
    }

    // Precios PVPC (ESIOS no tiene la restricción 429 de DATADIS).
    await fetchPvpcPrices(deps.esios, { startDate: isoDay(from), endDate: isoDay(to), tariff }, deps.writeApi);

    // Imputación de huecos: rellena las horas que DATADIS no devolvió con el mismo
    // slot de la semana anterior (gap="true", estimated="false"). Solo visualización.
    // Si DATADIS no devolvió nada, no hay sobre qué imputar (es NO_CONSUMPTION_DATA).
    if (consumptionPoints.length > 0) {
      const present = new Set(consumptionPoints.map(p => p.timestamp.toISOString()));
      await imputeConsumptionGaps(
        { cups, tariff, from, to, present, lookupPreviousWeek: makePreviousWeekLookup(deps.queryApi, bucket, cups) },
        deps.writeApi,
      );
    }

    deps.writeApi.flush();
  };
}
