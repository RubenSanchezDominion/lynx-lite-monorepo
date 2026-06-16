import type { CarbonDataSource, RawCarbonHour } from '../services/carbonData.js';

// DataSource de huella para el modo demo: genera una curva HORARIA determinista (sin Math.random) de
// consumo + factor de emisión sobre el rango pedido. El perfil concentra consumo en horas centrales
// (solar, factor bajo) y poco en la punta de tarde (factor alto), de modo que el factor propio sale
// por debajo de la media nacional → deltaPct negativo ("consume más limpio que la media").

const HOUR_MS = 3_600_000;

// Consumo base por hora (kWh). Industrial: alto a mediodía, medio mañana/tarde, bajo de noche.
function baseKwh(hour: number): number {
  if (hour >= 11 && hour < 16) return 30; // mediodía (solar)
  if (hour >= 19 && hour < 23) return 10; // punta de tarde-noche
  if (hour >= 7 && hour < 23) return 20; // resto del día
  return 3; // madrugada
}

// Factor de emisión determinista por franja (gCO₂/kWh): limpio a mediodía, sucio en la punta.
function factorGPerKwh(hour: number): number {
  if (hour >= 11 && hour < 16) return 120; // mucha solar/eólica
  if (hour >= 19 && hour < 23) return 450; // ciclo combinado en punta
  return 300; // media
}

// Variación determinista pequeña en [0.95, 1.05) a partir de un índice.
function jitter(i: number): number {
  return 0.95 + ((i * 2654435761) % 100) / 1000;
}

export function makeDemoCarbonDataSource(): CarbonDataSource {
  return {
    async load(_cups, from, to): Promise<RawCarbonHour[]> {
      const out: RawCarbonHour[] = [];
      const startMs = from.getTime();
      const endMs = to.getTime();
      let i = 0;
      for (let t = startMs; t < endMs; t += HOUR_MS, i++) {
        const d = new Date(t);
        const hour = d.getUTCHours();
        out.push({
          ts: d.toISOString(),
          kwh: baseKwh(hour) * jitter(i),
          gap: false,
          factorGPerKwh: factorGPerKwh(hour),
        });
      }
      return out;
    },
  };
}
