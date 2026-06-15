import type { PrismaClient, Supply, Contract } from '@prisma/client';
import { optimizePower, type OptimizationResult } from '@lynx-lite/optimization-engine';
import type { Tariff } from '@lynx-lite/data-collector';
import { gqlError } from '../lib/errors.js';
import { loadRegulatoryRates, powerPeriods } from './regulatory.js';
import { parseDay } from './preInvoiceService.js';
import type { PowerOptimizationDataSource } from './powerOptimizationData.js';

// Histórico mínimo para que el percentil y la detección de rachas sean significativos (SPECS §4.1).
const MIN_HISTORY_MONTHS = 12;

// Coeficiente de granularidad (empírico, calibrable por ops vía env sin recompilar). Si la variable
// no está o no es un número válido ≥ 1, el engine aplica su default (1.05 hourly / 1.00 quarter).
function envUplift(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export interface ComputedPowerOptimization {
  supply: Supply;
  analysisFrom: Date;
  analysisTo: Date;
  tariff: Tariff;
  granularity: 'hourly' | 'quarter';
  result: OptimizationResult;
}

export interface PowerOptimizationDeps {
  prisma: PrismaClient;
  dataSource: PowerOptimizationDataSource;
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
    out[`P${p}`] = (contract[key] as number | null) ?? 0;
  }
  return out;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Calcula una optimización de potencia sin persistir. Lanza los errores de SPECS §4.5.
export async function computePowerOptimization(
  input: { cups: string; analysisFrom: string; analysisTo: string },
  deps: PowerOptimizationDeps,
): Promise<ComputedPowerOptimization> {
  const { prisma, dataSource } = deps;
  const from = parseDay(input.analysisFrom);
  const to = parseDay(input.analysisTo);

  // 1. Suministro.
  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');

  // 2. Estado del backfill.
  assertBackfillReady(supply);

  const tariff = supply.tariff as Tariff;

  // 3. Contrato vigente (último): potencias actuales y fecha del último cambio (validFrom).
  const contract = await prisma.contract.findFirst({
    where: { supplyId: supply.id, validFrom: { lte: to } },
    orderBy: { validFrom: 'desc' },
  });
  if (!contract) throw gqlError('CONTRACT_NOT_FOUND');

  const contractedPower = contractedPowerMap(contract, tariff);
  const isMaxim = contract.modePowerControl === 'MAXIMETRO';

  // 4. Curva de carga (InfluxDB) → agregados del engine.
  const series = await dataSource.load(input.cups, from, to, tariff, contractedPower);
  if (!series.hasUsableData) throw gqlError('NO_CONSUMPTION_DATA');
  if (series.monthsWithData < MIN_HISTORY_MONTHS) {
    throw gqlError(
      'INSUFFICIENT_HISTORY',
      `Se requieren ${MIN_HISTORY_MONTHS} meses de curva; hay ${series.monthsWithData}`,
    );
  }

  // 5. Maestros regulatorios de potencia (el término de exceso solo se exige con maxímetro).
  const rates = await loadRegulatoryRates(prisma, supply.tariff, from, to, { requireExcess: isMaxim });

  // 6. Optimización (engine puro).
  const result = optimizePower({
    tariff,
    granularity: series.granularity,
    contractedPower,
    powerSamplesByPeriod: series.powerSamplesByPeriod,
    monthlyP99ByPeriod: series.monthlyP99ByPeriod,
    monthlyMaxByPeriod: series.monthlyMaxByPeriod,
    daysByMonth: series.daysByMonth,
    modePowerControl: contract.modePowerControl as 'ICP' | 'MAXIMETRO',
    overContractedRatioByPeriod: series.overContractedRatioByPeriod,
    tollRatesPower: rates.tollPower,
    chargeRatesPower: rates.chargePower,
    excessRatesPower: rates.excessPower,
    upliftHourly: envUplift('OPT_UPLIFT_HOURLY'),
    upliftQuarter: envUplift('OPT_UPLIFT_QUARTER'),
    lastPowerChangeDate: toISODate(contract.validFrom),
    analysisTo: toISODate(to),
  });

  return { supply, analysisFrom: from, analysisTo: to, tariff, granularity: series.granularity, result };
}
