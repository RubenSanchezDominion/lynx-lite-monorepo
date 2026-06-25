import type { PvProductionSeries } from '@lynx-lite/data-collector';
import type { SolarDataSource, RawSolarHour, SolarProductionParams } from '../services/solarData.js';

// DataSource de autoconsumo para el modo demo: curva de consumo + PVPC deterministas (sin Math.random)
// y producción PVGIS como SERIE HORARIA de año tipo (M06 v2), con forma intradía sesgada por azimut:
// Este (aspect −90) adelanta el pico a la mañana, Oeste (+90) lo retrasa a la tarde, Sur (0) al mediodía.

const HOUR_MS = 3_600_000;
// Factores estacionales ene..dic (mismos que el mock PVGIS).
const MONTHLY_FACTORS = [0.55, 0.65, 0.85, 1.1, 1.3, 1.45, 1.45, 1.35, 1.1, 0.85, 0.65, 0.5];
const FACTOR_SUM = MONTHLY_FACTORS.reduce((a, b) => a + b, 0);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Horas de luz aproximadas por mes (ene..dic), latitud media España.
const DAYLIGHT = [9.5, 10.5, 12, 13, 14, 14.5, 14.5, 13.5, 12, 11, 9.8, 9.2];

// Consumo base por hora (kWh) industrial BIMODAL: pico mañana y tarde, valle al mediodía (comida) y
// noche baja. Hace que la orientación E-O (dos jorobas) autoconsuma más que el Sur (una joroba).
function baseKwh(hour: number): number {
  if (hour >= 8 && hour < 12) return 30; // mañana
  if (hour >= 12 && hour < 16) return 12; // valle mediodía
  if (hour >= 16 && hour < 20) return 30; // tarde
  if (hour >= 20 && hour < 22) return 12;
  return 5; // noche
}
function basePvpc(hour: number): number {
  return hour >= 9 && hour < 22 ? 0.14 : 0.08;
}
function jitter(i: number): number {
  return 0.95 + ((i * 2654435761) % 100) / 1000;
}

// Serie horaria determinista de un año tipo (8760 h), escalada por kWp y pérdidas, sesgada por azimut.
function buildSeries(kwp: number, lossPct: number, azimuth: number): PvProductionSeries {
  const annual = kwp * 1500 * (1 - lossPct / 100); // ~1500 kWh/kWp
  const peakShift = azimuth / 22.5; // h: −90(E)→−4 (mañana), +90(O)→+4 (tarde), 0(S)→mediodía
  const hourly: PvProductionSeries['hourly'] = [];
  let total = 0;
  for (let m = 0; m < 12; m++) {
    const perDay = (annual * MONTHLY_FACTORS[m]) / FACTOR_SUM / DAYS[m];
    const center = 12 + peakShift;
    const half = DAYLIGHT[m] / 2;
    const w = new Array<number>(24).fill(0);
    let wsum = 0;
    for (let h = 0; h < 24; h++) {
      const d = (h + 0.5 - center) / half;
      const ww = Math.abs(d) < 1 ? Math.cos((d * Math.PI) / 2) : 0;
      w[h] = ww;
      wsum += ww;
    }
    for (let day = 1; day <= DAYS[m]; day++) {
      for (let h = 0; h < 24; h++) {
        const kwh = wsum > 0 ? (perDay * w[h]) / wsum : 0;
        hourly.push({ month: m + 1, day, hour: h, kwh });
        total += kwh;
      }
    }
  }
  return { hourly, annual: total };
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

    async fetchProduction(params: SolarProductionParams): Promise<PvProductionSeries> {
      return buildSeries(params.kwp, params.lossPct, params.azimuth);
    },
  };
}
