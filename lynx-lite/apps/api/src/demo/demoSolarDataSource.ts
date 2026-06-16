import type { PvProduction } from '@lynx-lite/data-collector';
import type { SolarDataSource, RawSolarHour, SolarProductionParams } from '../services/solarData.js';

// DataSource de autoconsumo para el modo demo: curva de consumo + PVPC deterministas (sin Math.random)
// y producción PVGIS mensual sintética (forma estacional: más en verano), escalada por kWp y pérdidas.

const HOUR_MS = 3_600_000;
// Factores estacionales ene..dic (mismos que el mock PVGIS).
const MONTHLY_FACTORS = [0.55, 0.65, 0.85, 1.1, 1.3, 1.45, 1.45, 1.35, 1.1, 0.85, 0.65, 0.5];
const FACTOR_SUM = MONTHLY_FACTORS.reduce((a, b) => a + b, 0);

// Consumo base por hora (kWh) industrial: alto de día, bajo de noche.
function baseKwh(hour: number): number {
  if (hour >= 8 && hour < 22) return 25;
  return 5;
}
function basePvpc(hour: number): number {
  return hour >= 9 && hour < 22 ? 0.14 : 0.08;
}
function jitter(i: number): number {
  return 0.95 + ((i * 2654435761) % 100) / 1000;
}

export function makeDemoSolarDataSource(): SolarDataSource {
  return {
    async loadConsumption(_cups, from, to): Promise<RawSolarHour[]> {
      const out: RawSolarHour[] = [];
      const startMs = from.getTime();
      const endMs = to.getTime();
      let i = 0;
      for (let t = startMs; t < endMs; t += HOUR_MS, i++) {
        const d = new Date(t);
        const hour = d.getUTCHours();
        out.push({ ts: d.toISOString(), kwh: baseKwh(hour) * jitter(i), pvpcEurKwh: basePvpc(hour), gap: false });
      }
      return out;
    },

    async fetchProduction(params: SolarProductionParams): Promise<PvProduction> {
      const annual = params.kwp * 1500 * (1 - params.lossPct / 100); // ~1500 kWh/kWp
      const monthly = MONTHLY_FACTORS.map(f => (annual * f) / FACTOR_SUM);
      return { monthly, annual };
    },
  };
}
