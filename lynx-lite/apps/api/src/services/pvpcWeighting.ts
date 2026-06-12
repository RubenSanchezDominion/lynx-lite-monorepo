// Ponderación PVPC por energía consumida (SPECS §3.4 paso 2).
// Función pura y testeable: alinea consumo y precio horarios por timestamp UTC.
//
// precio_ponderado[P] = Σ(precio_h × consumo_h) / Σ(consumo_h)  (solo horas del período P)
//
// Consumo y precio se almacenan ambos en UTC al inicio de cada hora, así que la
// misma hora de pared cae en el mismo instante UTC en ambas series (ver periods.ts).

export interface HourlyConsumptionRow {
  period: string; // 'P1'..'P6'
  time: string;   // ISO 8601 UTC (inicio de hora)
  kwh: number;
}

export interface HourlyPriceRow {
  time: string;   // ISO 8601 UTC
  eurKwh: number;
}

export interface AggregatedSeries {
  consumptionByPeriod: Record<string, number>;
  pvpcByPeriod: Record<string, number>;
}

export function aggregateConsumptionAndPvpc(
  consumption: HourlyConsumptionRow[],
  prices: HourlyPriceRow[],
): AggregatedSeries {
  // Índice de precio por instante UTC.
  const priceAt = new Map<string, number>();
  for (const p of prices) priceAt.set(p.time, p.eurKwh);

  const consumptionByPeriod: Record<string, number> = {};
  const weightedNum: Record<string, number> = {}; // Σ precio×consumo
  const weightDen: Record<string, number> = {};   // Σ consumo (con precio disponible)

  for (const c of consumption) {
    consumptionByPeriod[c.period] = (consumptionByPeriod[c.period] ?? 0) + c.kwh;

    const price = priceAt.get(c.time);
    if (price === undefined) continue; // sin precio para esa hora: no pondera
    weightedNum[c.period] = (weightedNum[c.period] ?? 0) + price * c.kwh;
    weightDen[c.period] = (weightDen[c.period] ?? 0) + c.kwh;
  }

  const pvpcByPeriod: Record<string, number> = {};
  for (const period of Object.keys(consumptionByPeriod)) {
    const den = weightDen[period] ?? 0;
    if (den > 0) {
      pvpcByPeriod[period] = weightedNum[period] / den;
    } else {
      // Sin consumo ponderable: media simple de los precios de ese período como respaldo.
      const periodPrices = pricesForPeriod(consumption, prices, period, priceAt);
      pvpcByPeriod[period] = periodPrices.length
        ? periodPrices.reduce((s, v) => s + v, 0) / periodPrices.length
        : 0;
    }
  }
  return { consumptionByPeriod, pvpcByPeriod };
}

// Precios que caen en las horas de un período (según el consumo observado).
function pricesForPeriod(
  consumption: HourlyConsumptionRow[],
  _prices: HourlyPriceRow[],
  period: string,
  priceAt: Map<string, number>,
): number[] {
  const out: number[] = [];
  for (const c of consumption) {
    if (c.period !== period) continue;
    const price = priceAt.get(c.time);
    if (price !== undefined) out.push(price);
  }
  return out;
}
