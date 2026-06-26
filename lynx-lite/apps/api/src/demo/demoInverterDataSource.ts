import { makeDemoSolarDataSource } from './demoSolarDataSource.js';
import type { InverterDataSource } from '../services/inverterData.js';

// DataSource demo de M06.3: reutiliza la curva de consumo + PVPC y el baseline PVGIS deterministas de
// M06 (sin Math.random). NO persiste (Fase 1 = análisis al vuelo, SPECS §8.12.0). La serie medida la
// aporta el fichero subido por el usuario; aquí solo se sirven consumo y baseline para el cruce.
export function makeDemoInverterDataSource(): InverterDataSource {
  const solar = makeDemoSolarDataSource();
  return {
    loadConsumption: solar.loadConsumption,
    fetchProduction: solar.fetchProduction,
    async persistMeasuredSeries(): Promise<void> {
      // demo: no-op (no hay almacén persistente; coherente con "datos del demo ya disponibles").
    },
  };
}
