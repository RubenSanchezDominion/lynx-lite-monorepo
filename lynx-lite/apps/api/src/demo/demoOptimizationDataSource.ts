import { periodForUtc, type Tariff } from '@lynx-lite/data-collector';
import {
  buildSeries,
  type CurvePoint,
  type PowerOptimizationDataSource,
  type PowerOptimizationSeries,
} from '../services/powerOptimizationData.js';

// DataSource de optimización para el modo demo: genera una curva HORARIA determinista
// (sin Math.random) sobre toda la ventana y la pasa por `buildSeries` (la misma lógica de
// agregación que la implementación InfluxDB). Pensado para ≥12 meses de histórico.

// kWh/hora base por período de ENERGÍA. La potencia derivada (kW) coincide con kWh (intervalo 1 h).
// 2.0TD pyme (contratado 10 kW, ICP) y 3.0TD industrial (contratado 50 kW, maxímetro).
// La mayoría de períodos quedan holgadamente por debajo de lo contratado (sobredimensionamiento),
// pero P6 (3.0TD) se sitúa por ENCIMA de 50 kW a propósito → infradimensionamiento real, para
// ejercitar el diagnóstico UNDERSIZED y un ahorro de excesos POSITIVO (penalizaciones evitadas).
const BASE_KW: Record<string, Record<string, number>> = {
  T_2_0TD: { P1: 6, P2: 6, P3: 4 },
  T_3_0TD: { P1: 36, P2: 38, P3: 30, P4: 24, P5: 18, P6: 54 },
};

// Máximo mensual de maxímetro (Pdp) por período de POTENCIA. Coherente con la curva: justo por
// encima del pico derivado (p99) y por debajo de la óptima en los períodos sobredimensionados
// (→ excesos ≈ 0), salvo P6, donde supera lo contratado (50) reflejando el infradimensionamiento.
const MAX_POWER: Record<string, Record<string, number>> = {
  T_2_0TD: { P1: 7, P2: 5 },
  T_3_0TD: { P1: 37, P2: 39, P3: 31, P4: 25, P5: 19, P6: 56 },
};

// Pseudoaleatorio determinista en [0,1) a partir de un índice (sin Math.random, reproducible).
function frac(i: number): number {
  return ((i * 2654435761) % 1000) / 1000;
}

function powerPeriodsOf(tariff: Tariff): string[] {
  return tariff === 'T_2_0TD' ? ['P1', 'P2'] : ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
}

export function makeDemoOptimizationDataSource(): PowerOptimizationDataSource {
  return {
    async load(_cups, from, to, tariff, contractedPower): Promise<PowerOptimizationSeries> {
      // Curva horaria sobre [from, to).
      const curve: CurvePoint[] = [];
      let i = 0;
      for (let t = from.getTime(); t <= to.getTime(); t += 3_600_000, i++) {
        const date = new Date(t);
        const energyPeriod = periodForUtc(date, tariff);
        const base = BASE_KW[tariff][energyPeriod] ?? 0;
        const kwh = base * (0.6 + 0.4 * frac(i)); // variación determinista [0.6, 1.0)·base
        curve.push({ time: date.toISOString(), kwh, energyPeriod });
      }

      // Máximos mensuales por período de potencia (un valor por mes).
      const maxPowerRows: { time: string; kw: number; period: string }[] = [];
      const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
      while (cursor.getTime() <= to.getTime()) {
        for (const pp of powerPeriodsOf(tariff)) {
          maxPowerRows.push({
            time: new Date(cursor).toISOString(),
            kw: MAX_POWER[tariff][pp] ?? 0,
            period: pp,
          });
        }
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }

      return buildSeries(curve, maxPowerRows, from, to, tariff, contractedPower);
    },
  };
}
