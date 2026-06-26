import type { QueryApi } from '@influxdata/influxdb-client';
import { fetchPvProductionSeries, type PvgisHttp, type PvProductionSeries } from '@lynx-lite/data-collector';
import type { RawSolarHour, SolarProductionParams } from './solarData.js';
import { makeInfluxSolarDataSource } from './solarData.js';

// Data source de M06.3 (producción FV real medida). Reutiliza la lectura de consumo+PVPC (InfluxDB) y el
// baseline PVGIS de M06. La serie MEDIDA NO entra por aquí: la trae el fichero subido (se parsea en el
// servicio). En Fase 1 NO se persiste (análisis al vuelo); `persistMeasuredSeries` queda LATENTE para
// cuando se monte InfluxDB (gemelo de `hourly_consumption` → measurement `pv_production_measured`).
export interface InverterDataSource {
  // Curva de consumo + PVPC sobre [from, to). Idéntica a M06 (reutiliza la composición de precio de M01).
  loadConsumption(cups: string, from: Date, to: Date): Promise<RawSolarHour[]>;
  // Baseline esperado: serie horaria PVGIS de año tipo para esa planta (para el performance check).
  fetchProduction(params: SolarProductionParams): Promise<PvProductionSeries>;
  // LATENTE (Fase 1 = no-op): persistir la serie medida en InfluxDB. Se activará con la infra real.
  persistMeasuredSeries(cups: string, points: Array<{ ts: string; kwh: number }>): Promise<void>;
}

// ─── Implementación real: InfluxDB (consumo+PVPC, lectura) + PVGIS (baseline) ───
// La escritura de la serie medida queda especificada pero inerte hasta montar InfluxDB (deuda consciente,
// SPECS §8.12.0). Convive con el demo igual que `makeInfluxSolarDataSource`.
export function makeInfluxInverterDataSource(queryApi: QueryApi, pvgis: PvgisHttp): InverterDataSource {
  const solar = makeInfluxSolarDataSource(queryApi, pvgis);
  return {
    loadConsumption: solar.loadConsumption,
    fetchProduction: solar.fetchProduction,
    async persistMeasuredSeries(_cups, _points): Promise<void> {
      // LATENTE: cuando exista InfluxDB, escribir aquí el measurement `pv_production_measured`
      // (tag cups, field kwh, _time hora UTC). Hoy no-op para no exigir infra (Fase 1 = análisis al vuelo).
    },
  };
}

// Reexport para el bootstrap real (mismo cliente PVGIS que M06).
export { fetchPvProductionSeries };
