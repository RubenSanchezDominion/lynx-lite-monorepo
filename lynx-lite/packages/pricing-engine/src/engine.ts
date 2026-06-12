import type { PricingInput, PricingResult, PricingLine } from './types.js';
import { computeExcessTerm } from './excess.js';

export function calculate(input: PricingInput): PricingResult {
  const lines: PricingLine[] = [];
  let sortOrder = 0;

  // Paso 1 — Término de potencia
  const powerPeriods = Object.keys(input.contractedPower).sort();
  let powerTerm = 0;

  for (const p of powerPeriods) {
    const periodNum = parseInt(p.slice(1), 10);
    const rate = (input.tollRates.power[p] ?? 0) + (input.chargeRates.power[p] ?? 0);
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

  // Paso 3 — Excesos de potencia (art. 9.4.b.1, tipos 4 y 5; solo MAXIMETRO)
  const excess = computeExcessTerm({
    modePowerControl: input.modePowerControl,
    contractedPower: input.contractedPower,
    maxPower: input.maxPower,
    excessRates: input.excessRates,
    days: input.periodDays,
  });
  const excessPower = excess.total;

  for (const l of excess.lines) {
    lines.push({
      concept: `Exceso de potencia P${l.period}`,
      period: l.period,
      quantity: l.excessKw,
      unit: 'kW',
      unitPrice: l.tepPerDay * l.days, // €/kW para el tramo de facturación
      amount: l.amount,
      sortOrder: ++sortOrder,
    });
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
