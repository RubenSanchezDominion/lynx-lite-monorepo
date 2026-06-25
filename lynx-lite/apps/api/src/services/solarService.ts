import type { PrismaClient, Supply } from '@prisma/client';
import { periodForUtc, type Tariff, type PvProductionSeries } from '@lynx-lite/data-collector';
import {
  simulateSolar,
  optimizeSizing,
  optimizeOrientation,
  type SolarHour,
  type SolarResult,
  type SolarSizingResult,
  type SolarOrientationResult,
  type FinancialParams,
} from '@lynx-lite/solar-engine';
import { gqlError } from '../lib/errors.js';
import { loadEnergyUnitRates } from './regulatory.js';
import type { SolarDataSource } from './solarData.js';

export interface SolarServiceDeps {
  prisma: PrismaClient;
  dataSource: SolarDataSource;
}

export interface SimulateSolarInput {
  cups: string;
  lat: number;
  lon: number;
  kwp: number;
  lossPct?: number;
  tilt?: number;
  azimuth?: number;
  costPerKwp?: number;
}

const MS_PER_YEAR = 365 * 86_400_000;
const HOUR_MS = 3_600_000;

// ─── Alineado de la serie horaria de PVGIS (seriescalc) a la curva del cliente ──
// SPECS §8.4 (M06 v2): la serie es de un año tipo; se cruza con cada hora de consumo por su misma
// posición de calendario (mes, día, hora) en UTC. Regla 29-feb → 28-feb. Puro y determinista.

function prodKey(month: number, day: number, hour: number): string {
  return `${month}-${day}-${hour}`;
}

// Mapa (mes,día,hora) → kWh a partir de la serie del año tipo. Exportado para test (TC-SOL-009).
export function buildProductionMap(series: PvProductionSeries): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of series.hourly) m.set(prodKey(e.month, e.day, e.hour), e.kwh);
  return m;
}

// Producción de la hora UTC `utc` según el mapa del año tipo. 29-feb reutiliza 28-feb; 0 si no hay dato.
export function productionForUtcHour(map: Map<string, number>, utc: Date): number {
  const month = utc.getUTCMonth() + 1;
  let day = utc.getUTCDate();
  const hour = utc.getUTCHours();
  if (month === 2 && day === 29) day = 28; // el año tipo no tiene 29-feb
  return map.get(prodKey(month, day, hour)) ?? 0;
}

// ─── [DEPRECADO M06 v2] Reparto de la producción mensual de PVGIS a horas (campana) ──
// Conservado por compatibilidad (ya no se invoca tras la migración a seriescalc). SPECS §8.4 v1.

// Día representativo de cada mes (aprox. Klein) para la declinación solar.
const MID_MONTH_DAY_OF_YEAR = [17, 46, 75, 105, 135, 162, 198, 228, 259, 289, 319, 345];

function declinationRad(dayOfYear: number): number {
  return (23.45 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365) * Math.PI) / 180;
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

// Pesos horarios (24) normalizados a Σ=1 con campana orto–ocaso, para un mes (0–11) y latitud.
export function hourWeightsForMonth(monthIdx: number, latDeg: number): number[] {
  const decl = declinationRad(MID_MONTH_DAY_OF_YEAR[monthIdx]);
  const lat = (latDeg * Math.PI) / 180;
  const cosH = Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(decl)));
  const halfDay = Math.acos(cosH); // ángulo horario de orto (rad)
  const daylight = 2 * halfDay * (12 / Math.PI); // horas de luz
  const sunrise = 12 - daylight / 2;
  const sunset = 12 + daylight / 2;

  const w = new Array<number>(24).fill(0);
  for (let h = 0; h < 24; h++) {
    const mid = h + 0.5;
    if (mid > sunrise && mid < sunset) {
      w[h] = Math.max(0, Math.sin((Math.PI * (mid - sunrise)) / (sunset - sunrise)));
    }
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map(x => x / sum) : w;
}

// Producción de una hora concreta: (E_m del mes / días del mes) × peso de la hora local.
export function hourlyProductionKwh(
  monthKey: string,
  localHour: number,
  monthlyKwh: number[],
  weightsByMonth: number[][],
): number {
  const year = Number(monthKey.slice(0, 4));
  const monthIdx = Number(monthKey.slice(5, 7)) - 1;
  const perDay = monthlyKwh[monthIdx] / daysInMonth(year, monthIdx);
  return perDay * (weightsByMonth[monthIdx][localHour] ?? 0);
}

// Mes ("YYYY-MM") y hora (0–23) de pared en Europe/Madrid.
const madridFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});
function madridMonthHour(utc: Date): { month: string; hour: number } {
  const p: Record<string, string> = {};
  for (const part of madridFmt.formatToParts(utc)) p[part.type] = part.value;
  return { month: `${p.year}-${p.month}`, hour: Number(p.hour) };
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

function validateParams(input: SimulateSolarInput): void {
  const lossPct = input.lossPct ?? 14;
  if (
    !(input.lat >= -90 && input.lat <= 90) ||
    !(input.lon >= -180 && input.lon <= 180) ||
    !(input.kwp > 0) ||
    !(lossPct >= 0 && lossPct <= 100)
  ) {
    throw gqlError('SOLAR_INVALID_PARAMS', 'lat/lon fuera de rango, kwp ≤ 0 o lossPct ∉ [0,100]');
  }
}

// Simula (o devuelve la simulación cacheada por parámetros). Persiste el resultado. La caché por
// parámetros la garantiza @@unique en Prisma: misma entrada → misma fila, sin re-llamar a PVGIS.
export async function simulateSolarForSupply(
  input: SimulateSolarInput,
  deps: SolarServiceDeps,
): Promise<unknown> {
  const { prisma, dataSource } = deps;
  validateParams(input);

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  const lat = input.lat;
  const lon = input.lon;
  const kwp = input.kwp;
  const lossPct = input.lossPct ?? 14;
  const tilt = input.tilt ?? 35;
  const azimuth = input.azimuth ?? 0;
  const costPerKwp = input.costPerKwp ?? 1000;

  // Caché por parámetros: si ya existe la simulación, se devuelve sin llamar a PVGIS.
  const cached = await prisma.solarSimulation.findUnique({
    where: { supplyId_lat_lon_kwp_lossPct_tilt_azimuth: { supplyId: supply.id, lat, lon, kwp, lossPct, tilt, azimuth } },
  });
  if (cached) return cached;

  // Producción PVGIS (lanza si no responde → PVGIS_UNAVAILABLE).
  let production;
  try {
    production = await dataSource.fetchProduction({ lat, lon, kwp, lossPct, tilt, azimuth });
  } catch {
    throw gqlError('PVGIS_UNAVAILABLE');
  }

  // Curva de consumo: últimos 12 meses disponibles.
  const to = new Date();
  const from = new Date(to.getTime() - MS_PER_YEAR);
  const rawHours = await dataSource.loadConsumption(supply.cups, from, to);
  if (rawHours.length === 0) throw gqlError('NO_CONSUMPTION_DATA');

  // Rango efectivo derivado de la curva (determinista, no depende de `now`).
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const h of rawHours) {
    const ms = Date.parse(h.ts);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  const rangeStart = new Date(minMs);
  const rangeEnd = new Date(maxMs + HOUR_MS);

  const tariff = supply.tariff as Tariff;
  const { tollEnergy, chargeEnergy } = await loadEnergyUnitRates(prisma, tariff, rangeStart, rangeEnd);

  const prodMap = buildProductionMap(production);

  let pvpcSum = 0;
  const hours: SolarHour[] = rawHours.map(h => {
    const d = new Date(h.ts);
    const { month } = madridMonthHour(d);
    const period = periodForUtc(d, tariff);
    const eurPerKwh = h.pvpcEurKwh + (tollEnergy[period] ?? 0) + (chargeEnergy[period] ?? 0);
    pvpcSum += h.pvpcEurKwh;
    return {
      ts: h.ts,
      month,
      consumptionKwh: h.kwh,
      productionKwh: productionForUtcHour(prodMap, d),
      eurPerKwh,
    };
  });

  // Excedentes valorados al PVPC medio del periodo (compensación simplificada; sin tope mensual v1).
  const surplusCompensationEurPerKwh = rawHours.length > 0 ? pvpcSum / rawHours.length : 0;
  const capexEur = kwp * costPerKwp;

  const result = simulateSolar({ hours, surplusCompensationEurPerKwh, capexEur });

  return persistSolarSimulation(
    { supply, lat, lon, kwp, lossPct, tilt, azimuth, costPerKwp, rangeStart, rangeEnd, result },
    prisma,
  );
}

export interface PersistSolarArgs {
  supply: Supply;
  lat: number;
  lon: number;
  kwp: number;
  lossPct: number;
  tilt: number;
  azimuth: number;
  costPerKwp: number;
  rangeStart: Date;
  rangeEnd: Date;
  result: SolarResult;
}

// Persiste la simulación. `monthlyProductionJson` guarda el desglose mensual COMPLETO
// (producción + autoconsumo + excedente) para poder servir `months` también desde caché.
export async function persistSolarSimulation(args: PersistSolarArgs, prisma: PrismaClient): Promise<unknown> {
  const { result } = args;
  return prisma.solarSimulation.create({
    data: {
      supplyId: args.supply.id,
      lat: args.lat,
      lon: args.lon,
      kwp: args.kwp,
      lossPct: args.lossPct,
      tilt: args.tilt,
      azimuth: args.azimuth,
      costPerKwp: args.costPerKwp,
      rangeStart: args.rangeStart,
      rangeEnd: args.rangeEnd,
      annualProductionKwh: result.annualProductionKwh,
      monthlyProductionJson: JSON.stringify(result.months),
      annualSelfConsumptionKwh: result.annualSelfConsumptionKwh,
      annualSurplusKwh: result.annualSurplusKwh,
      selfConsumptionRatio: result.selfConsumptionRatio,
      coverageRatio: result.coverageRatio,
      annualSavingEur: result.annualSavingEur,
      paybackYears: result.paybackYears,
    },
  });
}

// ─── §8.10 Optimización de dimensionado (no persiste) ───────────────────────────

export interface OptimizeSolarSizingInput {
  cups: string;
  lat: number;
  lon: number;
  lossPct?: number;
  tilt?: number;
  azimuth?: number;
  costPerKwp?: number;
  kwpMin: number;
  kwpMax: number;
  kwpStep?: number;
  maxBudgetEur?: number;
  financial?: FinancialParams;
}

// Validación común de lat/lon/loss (kwp se valida aparte por modo).
function assertLatLonLoss(lat: number, lon: number, lossPct: number): void {
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || !(lossPct >= 0 && lossPct <= 100)) {
    throw gqlError('SOLAR_INVALID_PARAMS', 'lat/lon fuera de rango o lossPct ∉ [0,100]');
  }
}

// Carga curva + maestros y devuelve las horas "tarificadas" (consumo + €/kWh) y la compensación de
// excedentes, sin la producción (que cada candidato/escalado añade). Reutiliza la composición de M01.
async function loadPricedHours(
  supply: Supply,
  prisma: PrismaClient,
  dataSource: SolarServiceDeps['dataSource'],
): Promise<{
  priced: Array<{ ts: string; d: Date; month: string; consumptionKwh: number; eurPerKwh: number }>;
  surplusCompensationEurPerKwh: number;
  rangeStart: Date;
  rangeEnd: Date;
}> {
  const to = new Date();
  const from = new Date(to.getTime() - MS_PER_YEAR);
  const rawHours = await dataSource.loadConsumption(supply.cups, from, to);
  if (rawHours.length === 0) throw gqlError('NO_CONSUMPTION_DATA');

  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const h of rawHours) {
    const ms = Date.parse(h.ts);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  const rangeStart = new Date(minMs);
  const rangeEnd = new Date(maxMs + HOUR_MS);

  const tariff = supply.tariff as Tariff;
  const { tollEnergy, chargeEnergy } = await loadEnergyUnitRates(prisma, tariff, rangeStart, rangeEnd);

  let pvpcSum = 0;
  const priced = rawHours.map(h => {
    const d = new Date(h.ts);
    const { month } = madridMonthHour(d);
    const period = periodForUtc(d, tariff);
    pvpcSum += h.pvpcEurKwh;
    return {
      ts: h.ts,
      d,
      month,
      consumptionKwh: h.kwh,
      eurPerKwh: h.pvpcEurKwh + (tollEnergy[period] ?? 0) + (chargeEnergy[period] ?? 0),
    };
  });
  const surplusCompensationEurPerKwh = rawHours.length > 0 ? pvpcSum / rawHours.length : 0;
  return { priced, surplusCompensationEurPerKwh, rangeStart, rangeEnd };
}

export async function optimizeSolarSizingForSupply(
  input: OptimizeSolarSizingInput,
  deps: SolarServiceDeps,
): Promise<SolarSizingResult> {
  const { prisma, dataSource } = deps;
  const lossPct = input.lossPct ?? 14;
  assertLatLonLoss(input.lat, input.lon, lossPct);
  if (!(input.kwpMin > 0) || !(input.kwpMax >= input.kwpMin)) {
    throw gqlError('SOLAR_INVALID_PARAMS', 'kwpMin ≤ 0 o kwpMax < kwpMin');
  }

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  const tilt = input.tilt ?? 35;
  const azimuth = input.azimuth ?? 0;
  const costPerKwp = input.costPerKwp ?? 1000;
  const kwpRef = input.kwpMax; // escalado lineal: cualquier ref positiva sirve (§8.10)

  let series;
  try {
    series = await dataSource.fetchProduction({ lat: input.lat, lon: input.lon, kwp: kwpRef, lossPct, tilt, azimuth });
  } catch {
    throw gqlError('PVGIS_UNAVAILABLE');
  }

  const { priced, surplusCompensationEurPerKwh } = await loadPricedHours(supply, prisma, dataSource);
  const prodMap = buildProductionMap(series);
  const baseHours: SolarHour[] = priced.map(p => ({
    ts: p.ts,
    month: p.month,
    consumptionKwh: p.consumptionKwh,
    productionKwh: productionForUtcHour(prodMap, p.d),
    eurPerKwh: p.eurPerKwh,
  }));

  const kwpStep = input.kwpStep ?? Math.max((input.kwpMax - input.kwpMin) / 20, 0.1);
  const result = optimizeSizing({
    baseHours,
    kwpRef,
    surplusCompensationEurPerKwh,
    costPerKwp,
    kwpMin: input.kwpMin,
    kwpMax: input.kwpMax,
    kwpStep,
    maxBudgetEur: input.maxBudgetEur ?? undefined,
    financial: input.financial,
  });
  if (result.curve.length === 0) {
    throw gqlError('SOLAR_INVALID_PARAMS', 'ningún kWp del rango cumple las restricciones (revisa maxBudgetEur / kwpMin)');
  }
  return result;
}

// ─── §8.11 Optimización de orientación (no persiste) ────────────────────────────

export interface OptimizeSolarOrientationInput {
  cups: string;
  lat: number;
  lon: number;
  kwp: number;
  lossPct?: number;
  costPerKwp?: number;
  tilts?: number[];
  azimuths?: number[];
  includeEastWestSplit?: boolean;
  financial?: FinancialParams;
}

export async function optimizeSolarOrientationForSupply(
  input: OptimizeSolarOrientationInput,
  deps: SolarServiceDeps,
): Promise<SolarOrientationResult> {
  const { prisma, dataSource } = deps;
  const lossPct = input.lossPct ?? 14;
  assertLatLonLoss(input.lat, input.lon, lossPct);
  if (!(input.kwp > 0)) throw gqlError('SOLAR_INVALID_PARAMS', 'kwp ≤ 0');

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');
  assertBackfillReady(supply);

  const costPerKwp = input.costPerKwp ?? 1000;
  const tilts = input.tilts && input.tilts.length > 0 ? input.tilts : [10, 20, 30, Math.round(input.lat)];
  const azimuths = input.azimuths && input.azimuths.length > 0 ? input.azimuths : [0, -45, 45, -90, 90];

  const { priced, surplusCompensationEurPerKwh } = await loadPricedHours(supply, prisma, dataSource);

  // Memo de mapas de producción por (tilt, azimut) a `input.kwp`: una sola llamada PVGIS por orientación
  // distinta dentro de esta petición (§8.11). El candidato E-O a dos aguas reutiliza E/W ya pedidos.
  const memo = new Map<string, Map<string, number>>();
  const prodMapFor = async (tilt: number, azimuth: number): Promise<Map<string, number>> => {
    const key = `${tilt}|${azimuth}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let series;
    try {
      series = await dataSource.fetchProduction({ lat: input.lat, lon: input.lon, kwp: input.kwp, lossPct, tilt, azimuth });
    } catch {
      throw gqlError('PVGIS_UNAVAILABLE');
    }
    const map = buildProductionMap(series);
    memo.set(key, map);
    return map;
  };

  const hoursWith = (prod: (d: Date) => number): SolarHour[] =>
    priced.map(p => ({
      ts: p.ts,
      month: p.month,
      consumptionKwh: p.consumptionKwh,
      productionKwh: prod(p.d),
      eurPerKwh: p.eurPerKwh,
    }));

  const perCandidate: Array<{ candidate: { tilt: number; azimuth: number; label?: string }; hours: SolarHour[] }> = [];
  for (const tilt of tilts) {
    for (const azimuth of azimuths) {
      const map = await prodMapFor(tilt, azimuth);
      perCandidate.push({ candidate: { tilt, azimuth }, hours: hoursWith(d => productionForUtcHour(map, d)) });
    }
  }

  // E-O a dos aguas: media de la serie Este y Oeste a igual tilt (suma de producción ANTES del cruce min).
  if (input.includeEastWestSplit ?? true) {
    const splitTilt = tilts[0];
    const mapE = await prodMapFor(splitTilt, -90);
    const mapW = await prodMapFor(splitTilt, 90);
    perCandidate.push({
      candidate: { tilt: splitTilt, azimuth: 0, label: 'E-O a dos aguas' },
      hours: hoursWith(d => 0.5 * productionForUtcHour(mapE, d) + 0.5 * productionForUtcHour(mapW, d)),
    });
  }

  const capexEur = input.kwp * costPerKwp;
  return optimizeOrientation({ perCandidate, surplusCompensationEurPerKwh, capexEur, financial: input.financial });
}
