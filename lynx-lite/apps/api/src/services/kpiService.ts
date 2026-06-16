import type { PrismaClient, Supply } from '@prisma/client';
import { periodForUtc, type Tariff } from '@lynx-lite/data-collector';
import {
  computeKpi,
  type ConsumptionHour,
  type GranularityName,
  type KpiResult,
  type ProductionInterval,
  type ShiftName,
} from '@lynx-lite/kpi-engine';
import { gqlError } from '../lib/errors.js';
import { loadEnergyUnitRates } from './regulatory.js';
import type { KpiDataSource } from './kpiData.js';

export interface KpiServiceDeps {
  prisma: PrismaClient;
  dataSource: KpiDataSource;
}

export interface ProductionRowInput {
  startTs: string;
  endTs: string;
  units: number;
  shift?: string | null;
  line?: string | null;
  batch?: string | null;
}

export interface SubmitProductionInput {
  cups: string;
  fileName: string;
  format: string; // "CSV" | "XLSX"
  rows: ProductionRowInput[];
}

interface ProductionRowRow {
  startTs: Date;
  endTs: Date;
  units: number;
  shift: ShiftName | null;
  line: string | null;
  batch: string | null;
}

// Hora de pared en Europe/Madrid como "YYYY-MM-DDTHH:mm:ss" (para la agregación del engine).
const madridFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function madridLocal(utc: Date): string {
  const p: Record<string, string> = {};
  for (const part of madridFmt.formatToParts(utc)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
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

function normShift(s?: string | null): ShiftName | null {
  return s === 'M' || s === 'T' || s === 'N' ? s : null;
}

// Valida las filas parseadas en el front y persiste el ProductionUpload + sus filas (SPECS §6.5).
export async function submitProduction(
  input: SubmitProductionInput,
  deps: KpiServiceDeps,
): Promise<{ id: string; rowCount: number }> {
  const { prisma } = deps;

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  if (!input.rows || input.rows.length === 0) throw gqlError('KPI_NO_PRODUCTION_DATA');

  const parsed: ProductionRowRow[] = input.rows.map(r => {
    const start = new Date(r.startTs);
    const end = new Date(r.endTs);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || !(r.units > 0)) {
      throw gqlError('KPI_INVALID_ROW', `Fila inválida: ${r.startTs}–${r.endTs} (${r.units} ud)`);
    }
    return { startTs: start, endTs: end, units: r.units, shift: normShift(r.shift), line: r.line ?? null, batch: r.batch ?? null };
  });

  // Solapamiento temporal entre tramos → no se puede atribuir el consumo de un CUPS único (§6.0 punto 3).
  const sorted = [...parsed].sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTs.getTime() < sorted[i - 1].endTs.getTime()) {
      throw gqlError('KPI_OVERLAPPING_INTERVALS', 'Hay tramos de producción que se solapan en el tiempo.');
    }
  }

  const rangeStart = sorted[0].startTs;
  const rangeEnd = parsed.reduce((mx, r) => (r.endTs > mx ? r.endTs : mx), parsed[0].endTs);

  const upload = (await prisma.productionUpload.create({
    data: {
      supplyId: supply.id,
      fileName: input.fileName,
      format: input.format as 'CSV' | 'XLSX',
      rowCount: parsed.length,
      rangeStart,
      rangeEnd,
      rows: {
        create: parsed.map(r => ({
          startTs: r.startTs,
          endTs: r.endTs,
          units: r.units,
          shift: r.shift,
          line: r.line,
          batch: r.batch,
        })),
      },
    },
    include: { rows: true },
  })) as { id: string; rowCount: number };

  return upload;
}

export interface ComputedKpi {
  supply: Supply;
  uploadId: string;
  rangeStart: Date;
  rangeEnd: Date;
  granularity: GranularityName;
  outlierPct: number;
  result: KpiResult;
}

// Carga el upload + la curva de consumo, compone el €/kWh (idéntico a M01) y ejecuta el engine.
// Cálculo puro (no persiste).
export async function runKpiComputation(
  input: { uploadId: string; granularity?: string; outlierPct?: number },
  deps: KpiServiceDeps,
): Promise<ComputedKpi> {
  const { prisma, dataSource } = deps;

  const upload = (await prisma.productionUpload.findUnique({
    where: { id: input.uploadId },
    include: { rows: true, supply: true },
  })) as
    | { id: string; rangeStart: Date; rangeEnd: Date; rows: ProductionRowRow[]; supply: Supply }
    | null;
  if (!upload) throw gqlError('KPI_UPLOAD_NOT_FOUND');

  const supply = upload.supply;
  assertBackfillReady(supply);

  const granularity = (input.granularity ?? 'DAY') as GranularityName;
  const outlierPct = input.outlierPct ?? 0.2;
  const tariff = supply.tariff as Tariff;

  const rawHours = await dataSource.load(supply.cups, upload.rangeStart, upload.rangeEnd, tariff);
  if (rawHours.length === 0) throw gqlError('NO_CONSUMPTION_DATA');

  // Composición del precio idéntica al término de energía de M01 (PVPC + peaje + cargo de energía).
  const { tollEnergy, chargeEnergy } = await loadEnergyUnitRates(prisma, tariff, upload.rangeStart, upload.rangeEnd);
  const consumption: ConsumptionHour[] = rawHours.map(h => {
    const period = periodForUtc(new Date(h.ts), tariff); // "P1".."P6"
    const eurPerKwh = h.pvpcEurKwh + (tollEnergy[period] ?? 0) + (chargeEnergy[period] ?? 0);
    return { ts: h.ts, hours: h.hours, kwh: h.kwh, eurPerKwh, gap: h.gap };
  });

  const production: ProductionInterval[] = upload.rows.map(r => ({
    startTs: new Date(r.startTs).toISOString(),
    endTs: new Date(r.endTs).toISOString(),
    localStart: madridLocal(new Date(r.startTs)),
    units: r.units,
    shift: r.shift ?? undefined,
    line: r.line ?? undefined,
    batch: r.batch ?? undefined,
  }));

  const result = computeKpi({ production, consumption, granularity, outlierPct });

  return { supply, uploadId: upload.id, rangeStart: upload.rangeStart, rangeEnd: upload.rangeEnd, granularity, outlierPct, result };
}

// Persiste (o recalcula, idempotente por uploadId+granularity) el KpiReport y sus líneas.
export async function persistKpiReport(computed: ComputedKpi, prisma: PrismaClient): Promise<unknown> {
  const { result } = computed;
  const scalars = {
    supplyId: computed.supply.id,
    uploadId: computed.uploadId,
    granularity: computed.granularity,
    rangeStart: computed.rangeStart,
    rangeEnd: computed.rangeEnd,
    totalUnits: result.totalUnits,
    totalKwh: result.totalKwh,
    totalCostEur: result.totalCostEur,
    avgEurPerUnit: result.avgEurPerUnit,
    baselineEurPerUnit: result.baselineEurPerUnit,
    outlierPct: computed.outlierPct,
    hasGaps: result.hasGaps,
  };
  const lines = result.buckets.map(b => ({
    bucketKey: b.key,
    bucketStart: new Date(b.bucketStart),
    units: b.units,
    kwh: b.kwh,
    costEur: b.costEur,
    eurPerUnit: b.eurPerUnit,
    isOutlier: b.isOutlier,
  }));

  const existing = (await prisma.kpiReport.findUnique({
    where: { uploadId_granularity: { uploadId: computed.uploadId, granularity: computed.granularity } },
  })) as { id: string } | null;

  if (existing) {
    await prisma.kpiReportLine.deleteMany({ where: { reportId: existing.id } });
    return prisma.kpiReport.update({
      where: { id: existing.id },
      data: { ...scalars, computedAt: new Date(), lines: { create: lines } },
      include: { lines: true },
    });
  }
  return prisma.kpiReport.create({ data: { ...scalars, lines: { create: lines } }, include: { lines: true } });
}
