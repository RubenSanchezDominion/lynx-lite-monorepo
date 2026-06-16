import type { WriteApi, QueryApi } from '@influxdata/influxdb-client';
import { fetchGenerationMix, type RedataHttp } from '@lynx-lite/data-collector';

const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

// Firma de ingesta on-demand del factor de emisión (system-wide, no por CUPS): asegura que
// `co2_factor` cubre el rango antes de calcular la huella (SPECS §7.0bis). Opcional: en demo no se
// inyecta (el factor lo genera el data source).
export type Co2Ingestion = (from: Date, to: Date) => Promise<void>;

// ¿Hay factor `co2_factor` en InfluxDB para el rango? (cobertura simple: ≥1 punto). Gate anti-llamadas.
export function makeCo2Coverage(queryApi: QueryApi) {
  return async (from: Date, to: Date): Promise<boolean> => {
    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${from.toISOString()}, stop: ${to.toISOString()})
        |> filter(fn: (r) => r._measurement == "co2_factor")
        |> limit(n: 1)
    `;
    const rows = await queryApi.collectRows(flux);
    return rows.length > 0;
  };
}

export interface Co2IngestionDeps {
  hasCoverage: (from: Date, to: Date) => Promise<boolean>;
  redata: RedataHttp;
  coeffs: Record<string, number>;
  writeApi: WriteApi;
}

// "YYYY-MM-DDTHH:mm" (formato que esperan REData y nuestro adaptador).
function redataStamp(d: Date): string {
  return d.toISOString().slice(0, 16);
}

// Construye la ingesta on-demand del factor: si InfluxDB ya cubre el rango, no llama a REData.
export function makeOnDemandCo2Ingestion(deps: Co2IngestionDeps): Co2Ingestion {
  return async (from, to) => {
    if (await deps.hasCoverage(from, to)) return;
    await fetchGenerationMix(
      deps.redata,
      { startDate: redataStamp(from), endDate: redataStamp(to) },
      deps.coeffs,
      deps.writeApi,
    );
    deps.writeApi.flush();
  };
}
