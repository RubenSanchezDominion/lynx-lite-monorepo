import type { PrismaClient, Supply } from '@prisma/client';
import {
  detectAlerts,
  type AlertTypeName,
  type DetectedAlert,
  type InactivityWindow,
  type SensitivityName,
} from '@lynx-lite/alerts-engine';
import type { Tariff } from '@lynx-lite/data-collector';
import { gqlError } from '../lib/errors.js';
import { energyPeriods } from './regulatory.js';
import { powerPeriodOf } from './powerOptimizationData.js';
import { parseDay } from './preInvoiceService.js';
import { REFERENCE_WEEKS, type AlertDataSource } from './alertData.js';

const ALL_TYPES: AlertTypeName[] = ['ZSCORE', 'PHANTOM', 'LIMIT', 'ESTIMATED'];

export interface AlertServiceDeps {
  prisma: PrismaClient;
  dataSource: AlertDataSource;
}

export interface ComputedAlerts {
  supply: Supply;
  day: Date;
  alerts: DetectedAlert[];
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

// Día evaluado por defecto: D-2 (último día cerrado tras la ingesta diaria, §1.5), medianoche UTC.
function defaultDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2));
}

interface AlertConfigRow {
  enabled: boolean;
  sensitivity: SensitivityName;
  enabledTypes: string; // CSV
  limitThresholdPct: number;
  phantomThresholdKwh: number;
  inactivityWindows: unknown; // Json
}

function parseEnabledTypes(csv: string): AlertTypeName[] {
  const set = new Set(
    csv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
  return ALL_TYPES.filter(t => set.has(t));
}

function parseWindows(json: unknown): InactivityWindow[] {
  if (!Array.isArray(json)) return [];
  return json as InactivityWindow[];
}

// Potencia contratada por período de ENERGÍA (mapeada al período de potencia en 2.0TD), para LIMIT.
function contractedPowerByEnergyPeriod(
  contract: Record<string, number | null>,
  tariff: Tariff,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ep of energyPeriods(tariff)) {
    const pp = powerPeriodOf(`P${ep}`, tariff); // "P1" | "P2" | …
    out[`P${ep}`] = (contract[`contractedPower${pp}`] as number | null) ?? 0;
  }
  return out;
}

// Evalúa las alertas de un suministro para un día. Detección pura (no persiste). Lanza los
// errores de SPECS §5.5. Devuelve `alerts: []` si la config existe pero está deshabilitada.
export async function runAlertEvaluation(
  input: { cups: string; day?: string },
  deps: AlertServiceDeps,
): Promise<ComputedAlerts> {
  const { prisma, dataSource } = deps;

  const supply = await prisma.supply.findUnique({ where: { cups: input.cups } });
  if (!supply) throw gqlError('SUPPLY_NOT_FOUND');

  assertBackfillReady(supply);

  const config = (await prisma.alertConfig.findUnique({
    where: { supplyId: supply.id },
  })) as AlertConfigRow | null;
  if (!config) throw gqlError('ALERT_CONFIG_NOT_FOUND');

  const day = input.day ? parseDay(input.day) : defaultDay();
  if (!config.enabled) return { supply, day, alerts: [] };

  const tariff = supply.tariff as Tariff;
  const enabledTypes = parseEnabledTypes(config.enabledTypes);

  // El contrato solo es necesario si LIMIT está activo.
  let contractedPower: Record<string, number> = {};
  if (enabledTypes.includes('LIMIT')) {
    const contract = await prisma.contract.findFirst({
      where: { supplyId: supply.id, validFrom: { lte: day } },
      orderBy: { validFrom: 'desc' },
    });
    if (!contract) throw gqlError('CONTRACT_NOT_FOUND');
    contractedPower = contractedPowerByEnergyPeriod(
      contract as unknown as Record<string, number | null>,
      tariff,
    );
  }

  const series = await dataSource.load(input.cups, day, tariff);
  if (!series.hasUsableData) throw gqlError('NO_CONSUMPTION_DATA');
  if (enabledTypes.includes('ZSCORE') && series.referenceWeeks < REFERENCE_WEEKS) {
    throw gqlError(
      'INSUFFICIENT_HISTORY',
      `Se requieren ${REFERENCE_WEEKS} semanas de referencia; hay ${series.referenceWeeks}`,
    );
  }

  const alerts = detectAlerts({
    targetDay: series.targetDay,
    referenceBySlot: series.referenceBySlot,
    contractedPower,
    intervalHours: series.intervalHours,
    config: {
      enabledTypes,
      sensitivity: config.sensitivity,
      limitThresholdPct: config.limitThresholdPct,
      phantomThresholdKwh: config.phantomThresholdKwh,
      inactivityWindows: parseWindows(config.inactivityWindows),
    },
  });

  return { supply, day, alerts };
}

// Persistencia idempotente (SPECS §5.4 Paso 5). No revive alertas ya gestionadas
// (ACKNOWLEDGED/DISMISSED). Reutilizable por el resolver y por el job de worker (futuro).
export async function persistDetectedAlerts(
  supplyId: string,
  alerts: DetectedAlert[],
  prisma: PrismaClient,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const a of alerts) {
    const where = {
      supplyId_type_windowStart_period: {
        supplyId,
        type: a.type,
        windowStart: new Date(a.windowStart),
        period: a.period,
      },
    };
    const existing = await prisma.alert.findUnique({ where });
    if (!existing) {
      out.push(
        await prisma.alert.create({
          data: {
            supplyId,
            type: a.type,
            severity: a.severity,
            status: 'NEW',
            period: a.period,
            windowStart: new Date(a.windowStart),
            windowEnd: new Date(a.windowEnd),
            observedValue: a.observedValue,
            expectedValue: a.expectedValue,
            deviation: a.deviation,
            message: a.message,
          },
        }),
      );
    } else if (existing.status === 'NEW') {
      out.push(
        await prisma.alert.update({
          where: { id: existing.id },
          data: {
            severity: a.severity,
            observedValue: a.observedValue,
            expectedValue: a.expectedValue,
            deviation: a.deviation,
            message: a.message,
          },
        }),
      );
    } else {
      out.push(existing); // ACKNOWLEDGED/DISMISSED → se respeta
    }
  }
  return out;
}
