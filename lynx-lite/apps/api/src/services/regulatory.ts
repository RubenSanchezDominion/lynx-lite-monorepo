import type { PrismaClient, Tariff, RateType } from '@prisma/client';
import { gqlError } from '../lib/errors.js';

// Períodos activos por tarifa (SPECS §3.4).
export function powerPeriods(tariff: Tariff): number[] {
  return tariff === 'T_2_0TD' ? [1, 2] : [1, 2, 3, 4, 5, 6];
}
export function energyPeriods(tariff: Tariff): number[] {
  return tariff === 'T_2_0TD' ? [1, 2, 3] : [1, 2, 3, 4, 5, 6];
}

export interface RegulatoryRates {
  tollPower: Record<string, number>;
  tollEnergy: Record<string, number>;
  chargePower: Record<string, number>;
  chargeEnergy: Record<string, number>;
  // tepp4-5 (€/kW·día) por período. {} si no se requiere (ICP).
  excessPower: Record<string, number>;
  ieeRate: number;
  vatRate: number;
  meterRentalPerDay: number;
  reactiveRates: { tier1Eur: number; tier2Eur: number } | null;
}

type RateRow = { period: number; rateType: RateType; eur: number };

// Selecciona el valor vigente para el período de facturación: validFrom <= from y
// (validTo null o >= to). Lanza REGULATORY_DATA_MISSING si falta algún período.
// `requireExcess` carga y valida el término de exceso (solo aplica con maxímetro).
export async function loadRegulatoryRates(
  prisma: PrismaClient,
  tariff: Tariff,
  from: Date,
  to: Date,
  opts: { requireExcess?: boolean } = {},
): Promise<RegulatoryRates> {
  const dateFilter = {
    validFrom: { lte: from },
    OR: [{ validTo: null }, { validTo: { gte: to } }],
  };

  const [tolls, charges, iee, vat, meter, reactive, excess] = await Promise.all([
    prisma.tollRate.findMany({ where: { tariff, ...dateFilter } }),
    prisma.chargeRate.findMany({ where: { tariff, ...dateFilter } }),
    prisma.iEERate.findFirst({ where: dateFilter }),
    prisma.vATRate.findFirst({ where: dateFilter }),
    prisma.meterRentalRate.findFirst({ where: { tariff, ...dateFilter } }),
    prisma.reactiveEnergyRate.findMany({ where: dateFilter }),
    opts.requireExcess
      ? prisma.excessPowerRate.findMany({ where: { tariff, ...dateFilter } })
      : Promise.resolve([] as { period: number; eurPerDay: number }[]),
  ]);

  if (!iee || !vat || !meter) throw gqlError('REGULATORY_DATA_MISSING', 'Faltan IEE/IVA/alquiler');

  const pPeriods = powerPeriods(tariff);
  const ePeriods = energyPeriods(tariff);

  const pick = (rows: RateRow[], type: RateType, periods: number[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of periods) {
      const row = rows.find(r => r.rateType === type && r.period === p);
      if (!row) throw gqlError('REGULATORY_DATA_MISSING', `Falta ${type} P${p} (${tariff})`);
      out[`P${p}`] = row.eur;
    }
    return out;
  };

  const excessPower: Record<string, number> = {};
  if (opts.requireExcess) {
    for (const p of pPeriods) {
      const row = excess.find(r => r.period === p);
      if (!row) throw gqlError('REGULATORY_DATA_MISSING', `Falta exceso de potencia P${p} (${tariff})`);
      excessPower[`P${p}`] = row.eurPerDay;
    }
  }

  const tier1 = reactive.find(r => r.tier === 1);
  const tier2 = reactive.find(r => r.tier === 2);

  return {
    tollPower: pick(tolls, 'POWER', pPeriods),
    tollEnergy: pick(tolls, 'ENERGY', ePeriods),
    chargePower: pick(charges, 'POWER', pPeriods),
    chargeEnergy: pick(charges, 'ENERGY', ePeriods),
    excessPower,
    ieeRate: iee.rate,
    vatRate: vat.rate,
    meterRentalPerDay: meter.eurPerDay,
    reactiveRates: tier1 && tier2 ? { tier1Eur: tier1.eur, tier2Eur: tier2.eur } : null,
  };
}

// Solo peaje + cargo de ENERGÍA por período (para componer el €/kWh de M04, idéntico al término
// de energía de M01). No carga IEE/IVA/alquiler/potencia: M04 no los necesita. Lanza
// REGULATORY_DATA_MISSING si falta algún período de energía.
export async function loadEnergyUnitRates(
  prisma: PrismaClient,
  tariff: Tariff,
  from: Date,
  to: Date,
): Promise<{ tollEnergy: Record<string, number>; chargeEnergy: Record<string, number> }> {
  const dateFilter = {
    validFrom: { lte: from },
    OR: [{ validTo: null }, { validTo: { gte: to } }],
  };

  const [tolls, charges] = await Promise.all([
    prisma.tollRate.findMany({ where: { tariff, ...dateFilter } }),
    prisma.chargeRate.findMany({ where: { tariff, ...dateFilter } }),
  ]);

  const ePeriods = energyPeriods(tariff);
  const pick = (rows: RateRow[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of ePeriods) {
      const row = rows.find(r => r.rateType === 'ENERGY' && r.period === p);
      if (!row) throw gqlError('REGULATORY_DATA_MISSING', `Falta ENERGY P${p} (${tariff})`);
      out[`P${p}`] = row.eur;
    }
    return out;
  };

  return { tollEnergy: pick(tolls), chargeEnergy: pick(charges) };
}
