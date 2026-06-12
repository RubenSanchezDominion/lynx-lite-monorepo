import type { Tariff } from '@lynx-lite/data-collector';
import type { PreInvoiceDataSource, PreInvoiceTimeSeries } from '../services/preInvoiceData.js';

// DataSource sintético para el modo demo: genera agregados por período deterministas
// (sin Math.random) escalados por los días del período, para que el motor calcule una
// prefactura creíble sin InfluxDB. NO hay huecos (gap=0).

function inclusiveDays(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
}

function energyPeriods(tariff: Tariff): string[] {
  return tariff === 'T_2_0TD' ? ['P1', 'P2', 'P3'] : ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
}
function powerPeriods(tariff: Tariff): string[] {
  return tariff === 'T_2_0TD' ? ['P1', 'P2'] : ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
}

// kWh/día por período (perfil tipo). 2.0TD pyme pequeña; 3.0TD industrial.
const DAILY_KWH: Record<string, Record<string, number>> = {
  T_2_0TD: { P1: 18, P2: 26, P3: 39 },
  T_3_0TD: { P1: 65, P2: 100, P3: 130, P4: 50, P5: 83, P6: 165 },
};
const PVPC: Record<string, Record<string, number>> = {
  T_2_0TD: { P1: 0.14, P2: 0.10, P3: 0.06 },
  T_3_0TD: { P1: 0.18, P2: 0.14, P3: 0.10, P4: 0.16, P5: 0.12, P6: 0.07 },
};
// kW de maxímetro por período (3.0TD): bajo el contratado (50) → sin excesos.
const MAX_POWER_30TD: Record<string, number> = { P1: 48, P2: 47, P3: 49, P4: 46, P5: 48, P6: 47 };

function consumptionByPeriod(tariff: Tariff, days: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of energyPeriods(tariff)) out[p] = DAILY_KWH[tariff][p] * days;
  return out;
}

export function makeDemoDataSource(): PreInvoiceDataSource {
  return {
    async load(_cups, from, to, tariff): Promise<PreInvoiceTimeSeries> {
      const days = inclusiveDays(from, to);
      const consumption = consumptionByPeriod(tariff, days);

      const maxPowerByPeriod: Record<string, number> = {};
      if (tariff === 'T_3_0TD') {
        for (const p of powerPeriods(tariff)) maxPowerByPeriod[p] = MAX_POWER_30TD[p];
      }

      return {
        consumptionByPeriod: consumption,
        maxPowerByPeriod,
        pvpcByPeriod: { ...PVPC[tariff] },
        gapHoursByPeriod: {},
        totalGapHours: 0,
        hasBillableData: true,
      };
    },

    async loadReactiveByPeriod(_cups, from, to): Promise<Record<string, number> | null> {
      // Solo se invoca para 3.0TD con meses completos. P1 con ratio ~0,45 → tramo 1;
      // resto por debajo del umbral → sin cargo.
      const days = inclusiveDays(from, to);
      const cons = consumptionByPeriod('T_3_0TD', days);
      return {
        P1: cons.P1 * 0.45,
        P2: cons.P2 * 0.20,
        P3: cons.P3 * 0.20,
        P4: cons.P4 * 0.20,
        P5: cons.P5 * 0.20,
        P6: cons.P6 * 0.20,
      };
    },
  };
}
