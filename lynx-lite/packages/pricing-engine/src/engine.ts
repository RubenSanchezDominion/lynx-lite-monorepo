import type { PricingInput, PricingResult, PricingLine } from './types.js';

export function calculate(input: PricingInput): PricingResult {
  const lines: PricingLine[] = [];
  let sortOrder = 0;

  // Paso 1 — Término de potencia
  const powerPeriods = Object.keys(input.contractedPower).sort();
  let powerTerm = 0;
  const combinedPowerRate: Record<string, number> = {};

  for (const p of powerPeriods) {
    const periodNum = parseInt(p.slice(1), 10);
    const rate = (input.tollRates.power[p] ?? 0) + (input.chargeRates.power[p] ?? 0);
    combinedPowerRate[p] = rate;
    const kwDays = input.contractedPower[p] * input.periodDays;
    const amount = kwDays * rate;
    powerTerm += amount;
    lines.push({
      concept: `Término de potencia ${p}`,
      period: periodNum,
      quantity: kwDays,
      unit: 'kW·día',
      unitPrice: rate,
      amount,
      sortOrder: ++sortOrder,
    });
  }

  // Paso 2 — Término de energía
  const energyPeriods = Object.keys(input.consumption).sort();
  let energyTerm = 0;

  for (const p of energyPeriods) {
    const periodNum = parseInt(p.slice(1), 10);
    const rate =
      (input.pvpcPrice[p] ?? 0) +
      (input.tollRates.energy[p] ?? 0) +
      (input.chargeRates.energy[p] ?? 0);
    const kwh = input.consumption[p];
    const amount = kwh * rate;
    energyTerm += amount;
    lines.push({
      concept: `Término de energía ${p}`,
      period: periodNum,
      quantity: kwh,
      unit: 'kWh',
      unitPrice: rate,
      amount,
      sortOrder: ++sortOrder,
    });
  }

  // Paso 3 — Excesos de potencia (solo MAXIMETRO)
  let excessPower = 0;

  if (input.modePowerControl === 'MAXIMETRO' && input.maxPower !== null) {
    for (const p of powerPeriods) {
      const periodNum = parseInt(p.slice(1), 10);
      const contracted = input.contractedPower[p];
      const measured = input.maxPower[p] ?? 0;

      if (measured > contracted * 1.05) {
        const excessKw = measured - contracted;
        const rate = combinedPowerRate[p];
        const amount = excessKw * rate * input.periodDays * 2;
        excessPower += amount;
        lines.push({
          concept: `Exceso de potencia ${p}`,
          period: periodNum,
          quantity: excessKw,
          unit: 'kW',
          unitPrice: rate * input.periodDays * 2,
          amount,
          sortOrder: ++sortOrder,
        });
      }
    }
  }

  // Paso 4 — Energía reactiva (solo 3.0TD con datos; P6 excluido)
  let reactiveEnergyTotal = 0;

  if (input.reactiveEnergy !== null && input.reactiveRates !== null) {
    const reactivePeriods = Object.keys(input.reactiveEnergy)
      .filter(p => p !== 'P6')
      .sort();

    for (const p of reactivePeriods) {
      const periodNum = parseInt(p.slice(1), 10);
      const reactive = input.reactiveEnergy[p];
      const active = input.consumption[p] ?? 0;

      if (active === 0 || reactive === 0) continue;

      const ratio = reactive / active;
      const exceso = Math.max(0, reactive - 0.33 * active);

      let charge = 0;
      let rate = 0;

      if (ratio > 0.75) {
        rate = input.reactiveRates.tier2Eur;
        charge = exceso * rate;
      } else if (ratio > 0.33) {
        rate = input.reactiveRates.tier1Eur;
        charge = exceso * rate;
      }

      if (charge > 0) {
        reactiveEnergyTotal += charge;
        lines.push({
          concept: `Energía reactiva ${p}`,
          period: periodNum,
          quantity: exceso,
          unit: 'kVArh',
          unitPrice: rate,
          amount: charge,
          sortOrder: ++sortOrder,
        });
      }
    }
  }

  // Paso 5 — Compensación por excedentes (v1: siempre 0)
  const surplusCompensation = 0;

  // Paso 6 — Base IEE e IEE
  const ieeBase =
    powerTerm + energyTerm + excessPower + reactiveEnergyTotal + surplusCompensation;
  const ieeAmount = ieeBase * input.ieeRate;

  // Paso 7 — Alquiler de contador
  const meterRental = input.meterRentalPerDay * input.periodDays;
  lines.push({
    concept: 'Alquiler de contador',
    period: null,
    quantity: input.periodDays,
    unit: 'día',
    unitPrice: input.meterRentalPerDay,
    amount: meterRental,
    sortOrder: ++sortOrder,
  });

  // Paso 8 — Subtotal e IVA
  const subtotal = ieeBase + ieeAmount + meterRental;

  lines.push({
    concept: 'Impuesto sobre la Electricidad (IEE)',
    period: null,
    quantity: ieeBase,
    unit: '%',
    unitPrice: input.ieeRate,
    amount: ieeAmount,
    sortOrder: ++sortOrder,
  });

  const vatAmount = subtotal * input.vatRate;
  lines.push({
    concept: 'IVA',
    period: null,
    quantity: subtotal,
    unit: '%',
    unitPrice: input.vatRate,
    amount: vatAmount,
    sortOrder: ++sortOrder,
  });

  // Paso 9 — Total
  const total = subtotal + vatAmount;

  return {
    powerTerm,
    energyTerm,
    excessPower,
    reactiveEnergy: reactiveEnergyTotal,
    surplusCompensation,
    meterRental,
    ieeBase,
    ieeAmount,
    subtotal,
    vatAmount,
    total,
    lines,
  };
}
