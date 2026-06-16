import type { SolarInput, SolarMonthBucket, SolarResult } from './types.js';

// Cálculo puro de la simulación de autoconsumo (SPECS §8.4). Sin redondeo intermedio. El engine no
// conoce husos, tarifas ni el perfil solar: recibe las series horarias ya construidas por el servicio.
export function simulateSolar(input: SolarInput): SolarResult {
  interface Acc {
    key: string;
    startMs: number;
    production: number;
    self: number;
    surplus: number;
  }
  const acc = new Map<string, Acc>();

  let annualProductionKwh = 0;
  let annualSelfConsumptionKwh = 0;
  let annualSurplusKwh = 0;
  let totalConsumptionKwh = 0;
  let annualSavingEur = 0;

  for (const h of input.hours) {
    const self = Math.min(h.productionKwh, h.consumptionKwh);
    const surplus = Math.max(0, h.productionKwh - h.consumptionKwh);
    const saving = self * h.eurPerKwh + surplus * input.surplusCompensationEurPerKwh;

    annualProductionKwh += h.productionKwh;
    annualSelfConsumptionKwh += self;
    annualSurplusKwh += surplus;
    totalConsumptionKwh += h.consumptionKwh;
    annualSavingEur += saving;

    const startMs = Date.parse(h.ts);
    const cur = acc.get(h.month) ?? { key: h.month, startMs, production: 0, self: 0, surplus: 0 };
    cur.production += h.productionKwh;
    cur.self += self;
    cur.surplus += surplus;
    if (startMs < cur.startMs) cur.startMs = startMs;
    acc.set(h.month, cur);
  }

  const months: SolarMonthBucket[] = [...acc.values()]
    .map(b => ({
      key: b.key,
      monthStart: new Date(b.startMs).toISOString(),
      productionKwh: b.production,
      selfConsumptionKwh: b.self,
      surplusKwh: b.surplus,
    }))
    .sort((a, b) => Date.parse(a.monthStart) - Date.parse(b.monthStart));

  return {
    months,
    annualProductionKwh,
    annualSelfConsumptionKwh,
    annualSurplusKwh,
    selfConsumptionRatio: annualProductionKwh > 0 ? annualSelfConsumptionKwh / annualProductionKwh : 0,
    coverageRatio: totalConsumptionKwh > 0 ? annualSelfConsumptionKwh / totalConsumptionKwh : 0,
    annualSavingEur,
    paybackYears: annualSavingEur > 0 ? input.capexEur / annualSavingEur : null,
  };
}
