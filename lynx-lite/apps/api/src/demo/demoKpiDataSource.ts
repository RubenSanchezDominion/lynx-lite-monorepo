import type { Tariff } from '@lynx-lite/data-collector';
import type { KpiDataSource, RawConsumptionHour } from '../services/kpiData.js';

// DataSource de KPI para el modo demo: genera una curva HORARIA determinista (sin Math.random) de
// consumo + PVPC sobre el rango pedido. El servicio compone el €/kWh con los maestros sembrados.
// Coherente con el ProductionUpload sembrado en store.ts (supply-30td, con un día de baja producción
// que produce un outlier ±20 %).

const HOUR_MS = 3_600_000;

// Consumo base por hora (kWh). Noche baja, día alto (igual idea que demoAlertDataSource).
function baseKwh(tariff: Tariff, hour: number): number {
  const night = hour < 7 || hour >= 23;
  if (tariff === 'T_2_0TD') return night ? 0.3 : 6;
  return night ? 0.5 : 30;
}

// Variación determinista pequeña en [0.95, 1.05) a partir de un índice.
function jitter(i: number): number {
  return 0.95 + ((i * 2654435761) % 100) / 1000;
}

// PVPC determinista por franja (€/kWh): caro en horas centrales, barato de madrugada.
function basePvpc(hour: number): number {
  return hour >= 9 && hour < 22 ? 0.14 : 0.08;
}

export function makeDemoKpiDataSource(): KpiDataSource {
  return {
    async load(_cups, from, to, tariff): Promise<RawConsumptionHour[]> {
      const out: RawConsumptionHour[] = [];
      const startMs = from.getTime();
      const endMs = to.getTime();
      let i = 0;
      for (let t = startMs; t < endMs; t += HOUR_MS, i++) {
        const d = new Date(t);
        const hour = d.getUTCHours();
        out.push({
          ts: d.toISOString(),
          hours: 1,
          kwh: baseKwh(tariff, hour) * jitter(i),
          pvpcEurKwh: basePvpc(hour),
          gap: false,
        });
      }
      return out;
    },
  };
}
