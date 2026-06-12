import type { PrismaClient, Supply, Contract } from '@prisma/client';
import { calculate, type PricingInput, type PricingResult } from '@lynx-lite/pricing-engine';
import type { Tariff } from '@lynx-lite/data-collector';
import { gqlError } from '../lib/errors.js';
import { loadRegulatoryRates, powerPeriods, energyPeriods } from './regulatory.js';
import type { PreInvoiceDataSource } from './preInvoiceData.js';

// ─── Utilidades de fecha ───────────────────────────────────────────────────────

// Parsea 'YYYY-MM-DD' como instante UTC a medianoche.
export function parseDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

// Días inclusivos entre dos fechas (2025-01-01..2025-01-31 = 31).
export function inclusiveDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / 86_400_000) + 1;
}

// ¿El período cubre uno o más meses naturales completos? (SPECS §3.4 paso 4).
export function isWholeNaturalMonths(from: Date, to: Date): boolean {
  if (from.getUTCDate() !== 1) return false;
  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  return to.getUTCDate() === lastDay;
}

// ─── Resultado del servicio ──────────────────────────────────────────────────

export interface ComputedPreInvoice {
  supply: Supply;
  periodFrom: Date;
  periodTo: Date;
  tariff: Tariff;
  pricing: PricingResult;
  reactiveApplied: boolean; // si false → reactiveEnergy se persiste como null
  gapHoursCount: number;
  gapPeriodsJson: Record<string, number> | null;
}

export interface PreInvoiceDeps {
  prisma: PrismaClient;
  dataSource: PreInvoiceDataSource;
  // Ingesta on-demand opcional (anti-429). Si se omite, se asume que el worker
  // ya tiene los datos (backfillStatus DONE).
  ensureData?: (cups: string, from: Date, to: Date, tariff: Tariff) => Promise<void>;
}

function assertBackfillReady(supply: Supply): void {
  switch (supply.backfillStatus) {
    case 'PENDING':
      throw gqlError('BACKFILL_PENDING');
    case 'RUNNING':
      throw gqlError('BACKFILL_RUNNING');
    case 'FAILED':
      throw gqlError('BACKFILL_FAILED');
  }
}

function contractedPowerMap(contract: Contract, tariff: Tariff): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of powerPeriods(tariff)) {
    const key = `contractedPowerP${p}` as keyof Contract;
    const value = contract[key] as number | null;
    out[`P${p}`] = value ?? 0;
  }
  return out;
}

// Calcula una pre-factura sin persistir. Lanza los errores de SPECS §3.5.
export async function computePreInvoice(
  input: { cups: string; periodFrom: string; periodTo: string },
  deps: PreInvoiceDeps,
): Promise<ComputedPreInvoice> {
  const { prisma, dataSource } = deps;
  const from = parseDay(input.periodFrom);
  const to = parseDay(input.periodTo);

  // 1. Suministro.
  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');

  // 2. Estado del backfill.
  assertBackfillReady(supply);

  const tariff = supply.tariff as Tariff;

  // 3. Contrato vigente para el período.
  const contract = await prisma.contract.findFirst({
    where: {
      supplyId: supply.id,
      validFrom: { lte: from },
      OR: [{ validTo: null }, { validTo: { gte: to } }],
    },
    orderBy: { validFrom: 'desc' },
  });
  if (!contract) throw gqlError('CONTRACT_NOT_FOUND');

  // 4. Ingesta on-demand si procede (anti-429 gestionado dentro de ensureData).
  if (deps.ensureData) await deps.ensureData(input.cups, from, to, tariff);

  // 5. Series temporales.
  const ts = await dataSource.load(input.cups, from, to, tariff);
  if (!ts.hasBillableData) throw gqlError('NO_CONSUMPTION_DATA');

  // 6. Maestros regulatorios (el término de exceso solo se exige con maxímetro).
  const isMaxim = contract.modePowerControl === 'MAXIMETRO';
  const rates = await loadRegulatoryRates(prisma, supply.tariff, from, to, { requireExcess: isMaxim });

  // 7. Reactiva: solo 3.0TD, meses naturales completos y datos disponibles.
  let reactiveEnergy: Record<string, number> | null = null;
  let reactiveApplied = false;
  if (tariff === 'T_3_0TD' && isWholeNaturalMonths(from, to) && rates.reactiveRates) {
    reactiveEnergy = await dataSource.loadReactiveByPeriod(input.cups, from, to);
    reactiveApplied = reactiveEnergy !== null;
  }

  // 8. Consumo y maxPower por período activo (rellena 0 los ausentes).
  const consumption: Record<string, number> = {};
  for (const p of energyPeriods(tariff)) consumption[`P${p}`] = ts.consumptionByPeriod[`P${p}`] ?? 0;

  let maxPower: Record<string, number> | null = null;
  if (isMaxim) {
    maxPower = {};
    for (const p of powerPeriods(tariff)) maxPower[`P${p}`] = ts.maxPowerByPeriod[`P${p}`] ?? 0;
  }

  const pvpcPrice: Record<string, number> = {};
  for (const p of energyPeriods(tariff)) pvpcPrice[`P${p}`] = ts.pvpcByPeriod[`P${p}`] ?? 0;

  // 9. PricingInput y cálculo.
  const pricingInput: PricingInput = {
    tariff,
    periodDays: inclusiveDays(from, to),
    modePowerControl: contract.modePowerControl as 'ICP' | 'MAXIMETRO',
    contractedPower: contractedPowerMap(contract, tariff),
    consumption,
    maxPower,
    excessRates: rates.excessPower,
    pvpcPrice,
    tollRates: { power: rates.tollPower, energy: rates.tollEnergy },
    chargeRates: { power: rates.chargePower, energy: rates.chargeEnergy },
    ieeRate: rates.ieeRate,
    vatRate: rates.vatRate,
    meterRentalPerDay: rates.meterRentalPerDay,
    reactiveEnergy: reactiveApplied ? reactiveEnergy : null,
    reactiveRates: reactiveApplied ? rates.reactiveRates : null,
    hasSurplus: contract.hasSurplus,
  };

  const pricing = calculate(pricingInput);

  const gapPeriodsJson = ts.totalGapHours > 0 ? ts.gapHoursByPeriod : null;

  return {
    supply,
    periodFrom: from,
    periodTo: to,
    tariff,
    pricing,
    reactiveApplied,
    gapHoursCount: ts.totalGapHours,
    gapPeriodsJson,
  };
}
