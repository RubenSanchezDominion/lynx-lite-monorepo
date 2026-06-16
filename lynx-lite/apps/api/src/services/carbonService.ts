import type { PrismaClient, Supply } from '@prisma/client';
import { computeCarbonFootprint, type CarbonResult, type ConsumptionHour } from '@lynx-lite/carbon-engine';
import { gqlError } from '../lib/errors.js';
import type { CarbonDataSource } from './carbonData.js';
import type { Co2Ingestion } from './carbonIngestion.js';

export interface CarbonServiceDeps {
  prisma: PrismaClient;
  dataSource: CarbonDataSource;
  ingestion?: Co2Ingestion; // ingesta on-demand del factor (no inyectada en demo)
}

export interface ComputeCarbonInput {
  cups: string;
  from: string; // ISO 8601 (inclusive)
  to: string; // ISO 8601 (exclusive)
}

// Mes de pared en Europe/Madrid como "YYYY-MM" (para los buckets mensuales del engine).
const madridFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
});
export function madridMonth(utc: Date): string {
  const p: Record<string, string> = {};
  for (const part of madridFmt.formatToParts(utc)) p[part.type] = part.value;
  return `${p.year}-${p.month}`;
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

export interface ComputedCarbon {
  supply: Supply;
  rangeStart: Date;
  rangeEnd: Date;
  result: CarbonResult;
}

// Carga la curva + el factor (asegurando la ingesta on-demand del factor) y ejecuta el engine.
// Cálculo puro (no persiste).
export async function runCarbonComputation(
  input: ComputeCarbonInput,
  deps: CarbonServiceDeps,
): Promise<ComputedCarbon> {
  const { prisma, dataSource } = deps;

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  const from = new Date(input.from);
  const to = new Date(input.to);

  // Asegura que `co2_factor` cubre el rango (en demo no hay ingesta: el data source ya trae el factor).
  if (deps.ingestion) await deps.ingestion(from, to);

  const rawHours = await dataSource.load(supply.cups, from, to);
  if (rawHours.length === 0) throw gqlError('NO_CONSUMPTION_DATA');
  if (rawHours.every(h => h.factorGPerKwh === null)) throw gqlError('CO2_NO_FACTOR_DATA');

  const consumption: ConsumptionHour[] = rawHours.map(h => ({
    ts: h.ts,
    month: madridMonth(new Date(h.ts)),
    kwh: h.kwh,
    gap: h.gap,
  }));
  const factors = rawHours
    .filter(h => h.factorGPerKwh !== null)
    .map(h => ({ ts: h.ts, gPerKwh: h.factorGPerKwh as number }));

  const result = computeCarbonFootprint({ consumption, factors });

  return { supply, rangeStart: from, rangeEnd: to, result };
}

// Persiste (o recalcula, idempotente por supplyId+rango) el CarbonReport y sus líneas mensuales.
export async function persistCarbonReport(computed: ComputedCarbon, prisma: PrismaClient): Promise<unknown> {
  const { result } = computed;
  const scalars = {
    supplyId: computed.supply.id,
    rangeStart: computed.rangeStart,
    rangeEnd: computed.rangeEnd,
    totalKwh: result.totalKwh,
    totalCo2Kg: result.totalCo2Kg,
    ownFactorGPerKwh: result.ownFactorGPerKwh,
    nationalAvgFactor: result.nationalAvgFactorGPerKwh,
    deltaPct: result.deltaPct,
    hasGaps: result.hasGaps,
  };
  const lines = result.months.map(m => ({
    monthKey: m.key,
    monthStart: new Date(m.monthStart),
    kwh: m.kwh,
    co2Kg: m.co2Kg,
    factorAvg: m.factorAvg,
    hasGaps: m.hasGaps,
  }));

  const existing = (await prisma.carbonReport.findUnique({
    where: {
      supplyId_rangeStart_rangeEnd: {
        supplyId: computed.supply.id,
        rangeStart: computed.rangeStart,
        rangeEnd: computed.rangeEnd,
      },
    },
  })) as { id: string } | null;

  if (existing) {
    await prisma.carbonReportLine.deleteMany({ where: { reportId: existing.id } });
    return prisma.carbonReport.update({
      where: { id: existing.id },
      data: { ...scalars, computedAt: new Date(), lines: { create: lines } },
      include: { lines: true },
    });
  }
  return prisma.carbonReport.create({ data: { ...scalars, lines: { create: lines } }, include: { lines: true } });
}
