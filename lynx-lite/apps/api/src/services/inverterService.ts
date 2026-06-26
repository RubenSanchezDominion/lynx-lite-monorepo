import type { PrismaClient, Supply } from '@prisma/client';
import { simulateSolar, type SolarHour } from '@lynx-lite/solar-engine';
import {
  applyMappingWithStats,
  validate,
  comparePerformance,
  detectMapping as detectMappingPure,
  SEED_PRESETS,
  type ColumnMapping,
  type ValidationReport,
  type PerformanceResult,
  type MappingProposal,
} from '@lynx-lite/inverter-ingest';
import { gqlError } from '../lib/errors.js';
import {
  loadPricedHours,
  buildProductionMap,
  productionForUtcHour,
  assertBackfillReady,
} from './solarService.js';
import type { InverterDataSource } from './inverterData.js';

export interface InverterServiceDeps {
  prisma: PrismaClient;
  dataSource: InverterDataSource;
}

export interface AnalyzeInverterUploadInput {
  cups: string;
  rows: string[][];
  mapping: ColumnMapping;
  kwp: number;
  lat: number; // para el baseline PVGIS del performance (como SimulateSolarInput)
  lon: number;
  lossPct?: number;
  tilt?: number;
  azimuth?: number;
  costPerKwp?: number;
  underperformanceThreshold?: number;
}

export interface RealSolarAnalysisMonth {
  monthKey: string;
  monthStart: string;
  productionKwh: number;
  selfConsumptionKwh: number;
  surplusKwh: number;
}

export interface RealSolarAnalysis {
  rangeStart: string;
  rangeEnd: string;
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number;
  coverageRatio: number;
  annualSavingEur: number;
  paybackYears: number | null;
  months: RealSolarAnalysisMonth[];
}

export interface InverterUploadResult {
  report: ValidationReport;
  realSolar: RealSolarAnalysis;
  performance: PerformanceResult;
}

const HOUR_MS = 3_600_000;

// §8.12.6 — detección de mapeo (solo lectura): propone columnas a partir de una muestra de filas crudas.
export function detectInverterMapping(sampleRows: string[][]): MappingProposal {
  return detectMappingPure(sampleRows, SEED_PRESETS);
}

function validateMapping(m: ColumnMapping): void {
  const decimalOk = m.decimal === ',' || m.decimal === '.';
  const tzOk = isValidTimezone(m.timezone);
  if (
    !m.timeColumn ||
    !Array.isArray(m.valueColumns) ||
    m.valueColumns.length === 0 ||
    !decimalOk ||
    !(m.unitScaleToKwh > 0) ||
    !tzOk
  ) {
    throw gqlError('INVERTER_INVALID_MAPPING', 'mapeo incoherente: revisa columna de valor, decimal, escala de unidad o huso');
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// §8.12 — analiza la subida del inversor AL VUELO (Fase 1: no persiste). Parsea+valida la serie medida,
// la cruza con el consumo real (reutiliza simulateSolar + la composición de precio de M01) y la compara
// con el baseline PVGIS (performance). Devuelve informe + análisis real + performance.
export async function analyzeInverterUpload(
  input: AnalyzeInverterUploadInput,
  deps: InverterServiceDeps,
): Promise<InverterUploadResult> {
  const { prisma, dataSource } = deps;

  if (
    !(input.kwp > 0) ||
    !(input.lat >= -90 && input.lat <= 90) ||
    !(input.lon >= -180 && input.lon <= 180)
  ) {
    throw gqlError('SOLAR_INVALID_PARAMS', 'kwp ≤ 0 o lat/lon fuera de rango');
  }
  validateMapping(input.mapping);

  const supply = (await prisma.supply.findUnique({ where: { cups: input.cups } })) as Supply | null;
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  // 1) Normalizar la serie medida (puro). Si nada parsea → error claro.
  const { points: measured, stats } = applyMappingWithStats(input.rows, input.mapping);
  if (measured.length === 0) {
    throw gqlError('INVERTER_PARSE_FAILED', 'ninguna fila parseó con el mapeo dado (revisa columna de tiempo y formato de fecha)');
  }

  // 2) Curva de consumo + precios sobre el rango de la serie medida (reutiliza la composición de M01).
  const rangeStart = new Date(measured[0].ts);
  const rangeEnd = new Date(Date.parse(measured[measured.length - 1].ts) + HOUR_MS);
  const { priced, surplusCompensationEurPerKwh } = await loadPricedHours(supply, prisma, {
    // loadPricedHours pide el último año disponible; aquí basta su lógica de carga de consumo y maestros.
    loadConsumption: (cups, _from, _to) => dataSource.loadConsumption(cups, rangeStart, rangeEnd),
    fetchProduction: dataSource.fetchProduction,
  });

  // 3) Cruce autoconsumo con producción MEDIDA: indexamos la medida por hora UTC y la inyectamos en las
  // horas tarificadas. Las horas sin medida (rango parcial) entran con producción 0.
  const measuredByTs = new Map<string, number>();
  for (const p of measured) measuredByTs.set(p.ts, p.kwh);
  const hours: SolarHour[] = priced.map(p => ({
    ts: p.ts,
    month: p.month,
    consumptionKwh: p.consumptionKwh,
    productionKwh: measuredByTs.get(p.ts) ?? 0,
    eurPerKwh: p.eurPerKwh,
  }));
  const real = simulateSolar({ hours, surplusCompensationEurPerKwh, capexEur: input.kwp * (input.costPerKwp ?? 1000) });

  // 4) Baseline PVGIS alineado a las horas medidas → performance (PR, kWh/kWp).
  let series;
  try {
    series = await dataSource.fetchProduction({
      lat: input.lat,
      lon: input.lon,
      kwp: input.kwp,
      lossPct: input.lossPct ?? 14,
      tilt: input.tilt ?? 35,
      azimuth: input.azimuth ?? 0,
    });
  } catch {
    throw gqlError('PVGIS_UNAVAILABLE');
  }
  const prodMap = buildProductionMap(series);
  const expected = measured.map(p => ({ ts: p.ts, kwh: productionForUtcHour(prodMap, new Date(p.ts)) }));
  const performance = comparePerformance({
    measured,
    expected,
    kwp: input.kwp,
    underperformanceThreshold: input.underperformanceThreshold,
  });

  // 5) Validación (cobertura, huecos, solape con consumo). No persiste (Fase 1).
  const report = validate(measured, input.mapping, stats, {
    from: rangeStart.toISOString(),
    to: rangeEnd.toISOString(),
  });

  const realSolar: RealSolarAnalysis = {
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    annualProductionKwh: real.annualProductionKwh,
    annualSelfConsumptionKwh: real.annualSelfConsumptionKwh,
    annualSurplusKwh: real.annualSurplusKwh,
    selfConsumptionRatio: real.selfConsumptionRatio,
    coverageRatio: real.coverageRatio,
    annualSavingEur: real.annualSavingEur,
    paybackYears: real.paybackYears,
    months: real.months.map(m => ({
      monthKey: m.key,
      monthStart: m.monthStart,
      productionKwh: m.productionKwh,
      selfConsumptionKwh: m.selfConsumptionKwh,
      surplusKwh: m.surplusKwh,
    })),
  };

  return { report, realSolar, performance };
}
