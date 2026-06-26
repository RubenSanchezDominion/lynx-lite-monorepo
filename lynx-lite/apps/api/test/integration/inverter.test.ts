import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    supply: d('findUnique'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setInverterDataSource } from '../../src/services/runtime.js';
import type { InverterDataSource } from '../../src/services/inverterData.js';
import type { RawSolarHour } from '../../src/services/solarData.js';
import type { PvProductionSeries } from '@lynx-lite/data-collector';

// Baseline PVGIS (año tipo) con producción de mediodía en junio-15 a ~20 kWh/h de pico.
function baseline(): PvProductionSeries {
  const hourly: PvProductionSeries['hourly'] = [];
  for (let h = 0; h < 24; h++) {
    const d = (h - 12) / 4;
    const kwh = Math.abs(d) < 1 ? Math.cos((d * Math.PI) / 2) * 20 : 0;
    hourly.push({ month: 6, day: 15, hour: h, kwh });
  }
  return { hourly, annual: hourly.reduce((a, x) => a + x.kwh, 0) };
}

// Consumo demo: mediodía junio-15 con PVPC conocido (mismas horas que la serie medida del fichero).
function defaultConsumption(): RawSolarHour[] {
  return [
    { ts: '2025-06-15T10:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
    { ts: '2025-06-15T11:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
    { ts: '2025-06-15T12:00:00.000Z', kwh: 20, pvpcEurKwh: 0.1, gap: false },
  ];
}

const persistSpy = vi.fn(async () => {});
let consumption: RawSolarHour[];
const dataSource: InverterDataSource = {
  loadConsumption: vi.fn(async () => consumption),
  fetchProduction: vi.fn(async () => baseline()),
  persistMeasuredSeries: persistSpy,
};
setInverterDataSource(dataSource);

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };
const USUARIO_S1 = { id: 'u1', role: 'USUARIO' as const, supplyId: 's1' };

function setupSupply(over: Record<string, unknown> = {}) {
  mockPrisma.supply.findUnique.mockResolvedValue({
    id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE', ...over,
  });
}
function setupRates() {
  mockPrisma.tollRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.02 })));
  mockPrisma.chargeRate.findMany.mockResolvedValue([1, 2, 3].map(p => ({ rateType: 'ENERGY', period: p, eur: 0.01 })));
}

// Serie medida del inversor: las MISMAS 3 horas que el consumo (en hora UTC), energía de intervalo.
const ROWS = [
  ['ts', 'kwh'],
  ['2025-06-15T10:00:00Z', '15'],
  ['2025-06-15T11:00:00Z', '18'],
  ['2025-06-15T12:00:00Z', '17'],
];
const MAPPING = {
  timeColumn: 'ts',
  timeFormat: 'ISO',
  valueColumns: ['kwh'],
  valueKind: 'ENERGY_INTERVAL',
  unitScaleToKwh: 1,
  decimal: '.',
  timezone: 'UTC',
  skipRows: 0,
};
const baseInput = { cups: 'ES_CUPS', rows: ROWS, mapping: MAPPING, kwp: 10, lat: 41.65, lon: -0.88 };

const ANALYZE = `mutation($i: AnalyzeInverterUploadInput!) {
  analyzeInverterUpload(input: $i) {
    report { rowsParsed coveragePct consumptionOverlapPct detectedUnit }
    realSolar { annualProductionKwh annualSelfConsumptionKwh annualSavingEur months { monthKey productionKwh } }
    performance { measuredKwh expectedKwh performanceRatio specificYieldKwhPerKwp underperforming }
  }
}`;
const DETECT = `query($i: DetectInverterMappingInput!) {
  detectInverterMapping(input: $i) { mapping { timeColumn valueKind decimal } confidence presetMatched warnings }
}`;

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  (dataSource.loadConsumption as ReturnType<typeof vi.fn>).mockClear();
  (dataSource.fetchProduction as ReturnType<typeof vi.fn>).mockClear();
  persistSpy.mockClear();
  consumption = defaultConsumption();
});

describe('TC-INV-014 — analyzeInverterUpload cruza con consumo real (reutiliza simulateSolar)', () => {
  it('produce realSolar con autoconsumo y ahorro a partir de la serie MEDIDA', async () => {
    setupSupply();
    setupRates();
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    const data = r.data?.analyzeInverterUpload as {
      realSolar: { annualProductionKwh: number; annualSelfConsumptionKwh: number; annualSavingEur: number; months: unknown[] };
      report: { rowsParsed: number; detectedUnit: string };
    };
    // Producción medida = 15+18+17 = 50; todo autoconsumido (consumo 20/h ≥ producción/h).
    expect(data.realSolar.annualProductionKwh).toBeCloseTo(50, 3);
    expect(data.realSolar.annualSelfConsumptionKwh).toBeCloseTo(50, 3);
    // Ahorro = 50 kWh × eurPerKwh; eurPerKwh = 0.1 (pvpc) + 0.02 (toll) + 0.01 (charge) = 0.13.
    expect(data.realSolar.annualSavingEur).toBeCloseTo(50 * 0.13, 3);
    expect(data.report.rowsParsed).toBe(3);
    expect(data.report.detectedUnit).toBe('ENERGY_INTERVAL');
  });

  it('performance compara medido vs baseline PVGIS (PR, kWh/kWp)', async () => {
    setupSupply();
    setupRates();
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    const perf = (r.data?.analyzeInverterUpload as { performance: { measuredKwh: number; expectedKwh: number; performanceRatio: number; specificYieldKwhPerKwp: number } }).performance;
    // baseline a las 10/11/12 = cos(((h-12)/4)·π/2)·20 → ~14.14, ~18.48, 20 ; medido 15/18/17.
    expect(perf.measuredKwh).toBeCloseTo(50, 3);
    expect(perf.expectedKwh).toBeGreaterThan(0);
    expect(perf.performanceRatio).toBeCloseTo(50 / perf.expectedKwh, 3);
    expect(perf.specificYieldKwhPerKwp).toBeCloseTo(50 / 10, 3);
  });
});

describe('TC-INV-015 — analyzeInverterUpload no persiste', () => {
  it('no llama a persistMeasuredSeries (Fase 1: análisis al vuelo)', async () => {
    setupSupply();
    setupRates();
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    expect(r.errors).toBeUndefined();
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

describe('TC-INV-016 — errores y autorización', () => {
  it('kwp=0 → SOLAR_INVALID_PARAMS', async () => {
    setupSupply();
    const r = await runOp(server, ANALYZE, { variables: { i: { ...baseInput, kwp: 0 } }, user: DOMINION });
    expect(errorCode(r)).toBe('SOLAR_INVALID_PARAMS');
  });

  it('sin curva de consumo → NO_CONSUMPTION_DATA', async () => {
    setupSupply();
    setupRates();
    consumption = [];
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    expect(errorCode(r)).toBe('NO_CONSUMPTION_DATA');
  });

  it('mapeo sin columna de valor → INVERTER_INVALID_MAPPING', async () => {
    setupSupply();
    const bad = { ...baseInput, mapping: { ...MAPPING, valueColumns: [] } };
    const r = await runOp(server, ANALYZE, { variables: { i: bad }, user: DOMINION });
    expect(errorCode(r)).toBe('INVERTER_INVALID_MAPPING');
  });

  it('ninguna fila parseable → INVERTER_PARSE_FAILED', async () => {
    setupSupply();
    setupRates();
    const bad = { ...baseInput, rows: [['ts', 'kwh'], ['no-es-fecha', 'x']] };
    const r = await runOp(server, ANALYZE, { variables: { i: bad }, user: DOMINION });
    expect(errorCode(r)).toBe('INVERTER_PARSE_FAILED');
  });

  it('USUARIO → FORBIDDEN', async () => {
    setupSupply();
    setupRates();
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: USUARIO_S1 });
    expect(errorCode(r)).toBe('FORBIDDEN');
  });

  it('CUPS inexistente → SUPPLY_NOT_FOUND', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue(null);
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    expect(errorCode(r)).toBe('SUPPLY_NOT_FOUND');
  });

  it('backfill no listo → BACKFILL_PENDING', async () => {
    setupSupply({ backfillStatus: 'PENDING' });
    setupRates();
    const r = await runOp(server, ANALYZE, { variables: { i: baseInput }, user: DOMINION });
    expect(errorCode(r)).toBe('BACKFILL_PENDING');
  });
});

describe('detectInverterMapping — lectura asistida', () => {
  it('propone columnas para una muestra cruda', async () => {
    setupSupply();
    const r = await runOp(server, DETECT, {
      variables: { i: { cups: 'ES_CUPS', sampleRows: [['Fecha', 'Energy (kWh)'], ['01/06/2026 10:00', '5']] } },
      user: DOMINION,
    });
    expect(r.errors).toBeUndefined();
    const prop = r.data?.detectInverterMapping as { mapping: { valueKind: string }; confidence: number };
    expect(prop.mapping.valueKind).toBe('ENERGY_INTERVAL');
    expect(prop.confidence).toBeGreaterThan(0);
  });
});
