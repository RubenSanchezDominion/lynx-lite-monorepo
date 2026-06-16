import type { Tariff } from '@lynx-lite/data-collector';
import { buildAlertSeries, type AlertDataSource, type AlertSeries, type RawPoint } from '../services/alertData.js';

// DataSource de alertas para el modo demo: genera una curva HORARIA determinista (sin Math.random)
// con anomalías sembradas, de modo que `evaluateAlerts` produzca los cuatro tipos de alerta.
// Coherente con la AlertConfig sembrada en store.ts (franja inactiva 00:00–06:00, umbral PHANTOM 1)
// y con las potencias contratadas demo (2.0TD 10 kW · 3.0TD 50 kW).

const DAY_MS = 86_400_000;
const REF_WEEKS = 14; // ≥ 13 para superar INSUFFICIENT_HISTORY

// Consumo base por hora (kWh ≈ kW en intervalos de 1 h). Noche baja para que el PHANTOM destaque.
function baseKwh(tariff: Tariff, hour: number): number {
  const night = hour < 7 || hour >= 23;
  if (tariff === 'T_2_0TD') return night ? 0.3 : 6;
  return night ? 0.5 : 30;
}

// Variación determinista pequeña en [0.95, 1.05) a partir de un índice.
function jitter(i: number): number {
  return 0.95 + ((i * 2654435761) % 100) / 1000;
}

export function makeDemoAlertDataSource(): AlertDataSource {
  return {
    async load(_cups, day, tariff): Promise<AlertSeries> {
      const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      const limitKwh = tariff === 'T_2_0TD' ? 9.7 : 49; // ≥ 95 % de la potencia contratada → LIMIT

      // Día evaluado, con anomalías sembradas en horas concretas.
      const target: RawPoint[] = [];
      for (let h = 0; h < 24; h++) {
        const time = new Date(dayStart + h * 3_600_000).toISOString();
        let kwh = baseKwh(tariff, h);
        let estimated = false;
        let gap = false;
        if (h === 12) kwh = baseKwh(tariff, 12) * 5; // pico → ZSCORE
        else if (h === 20) kwh = limitKwh; // cerca del límite → LIMIT
        else if (h === 3) kwh = 4; // consumo nocturno en franja inactiva → PHANTOM
        else if (h === 15) {
          estimated = true; // dato estimado → ESTIMATED
          gap = true;
        }
        target.push({ time, kwh, estimated, gap });
      }

      // Referencia: 14 semanas previas, mismas horas, consumo "normal" (baja varianza).
      const reference: RawPoint[] = [];
      for (let w = 1; w <= REF_WEEKS; w++) {
        for (let h = 0; h < 24; h++) {
          const time = new Date(dayStart - w * 7 * DAY_MS + h * 3_600_000).toISOString();
          reference.push({
            time,
            kwh: baseKwh(tariff, h) * jitter(w * 24 + h),
            estimated: false,
            gap: false,
          });
        }
      }

      return buildAlertSeries(target, reference, tariff);
    },
  };
}
