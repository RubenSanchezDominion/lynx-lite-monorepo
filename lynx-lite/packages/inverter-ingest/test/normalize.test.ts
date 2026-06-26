import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyMapping,
  applyMappingWithStats,
  parseNumber,
  parseCsv,
  detectMapping,
  validate,
  type ColumnMapping,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

// Mapeo base reutilizable; cada test ajusta lo que necesita.
function mapping(over: Partial<ColumnMapping> = {}): ColumnMapping {
  return {
    timeColumn: 'ts',
    timeFormat: 'ISO',
    valueColumns: ['v'],
    valueKind: 'ENERGY_INTERVAL',
    unitScaleToKwh: 1,
    decimal: '.',
    timezone: 'UTC',
    skipRows: 0,
    ...over,
  };
}

describe('TC-INV-001 — energía de intervalo directa', () => {
  it('toma kWh por fila y agrega a hora sin transformar', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T10:00:00Z', '5'],
      ['2026-06-01T10:30:00Z', '3'],
      ['2026-06-01T11:00:00Z', '4'],
    ];
    const pts = applyMapping(rows, mapping());
    expect(pts).toHaveLength(2);
    expect(pts[0].kwh).toBeCloseTo(8, 6); // 5 + 3 en la hora 10
    expect(pts[1].kwh).toBeCloseTo(4, 6);
  });
});

describe('TC-INV-002 — kW→kWh por integración del paso', () => {
  it('potencia constante 4 kW en 4×15 min → 4 kWh/hora', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T10:00:00Z', '4'],
      ['2026-06-01T10:15:00Z', '4'],
      ['2026-06-01T10:30:00Z', '4'],
      ['2026-06-01T10:45:00Z', '4'],
      ['2026-06-01T11:00:00Z', '4'], // marca el cierre del último tramo de las 10
    ];
    const pts = applyMapping(rows, mapping({ valueKind: 'POWER' }));
    expect(pts[0].kwh).toBeCloseTo(4, 6); // 4 kW × (4 × 0.25 h)
  });
});

describe('TC-INV-003 — acumulado total → diferencia', () => {
  it('serie monótona → energía = diff; primer punto no produce kWh', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T10:00:00Z', '1000'],
      ['2026-06-01T11:00:00Z', '1015'],
      ['2026-06-01T12:00:00Z', '1040'],
    ];
    const pts = applyMapping(rows, mapping({ valueKind: 'CUMULATIVE_TOTAL' }));
    expect(pts).toHaveLength(2); // el primero no tiene previo
    expect(pts[0].kwh).toBeCloseTo(15, 6);
    expect(pts[1].kwh).toBeCloseTo(25, 6);
  });
});

describe('TC-INV-004 — acumulado diario con reset', () => {
  it('caída a 0 a medianoche local → diff negativa descartada, no resta', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T22:00:00Z', '40'],
      ['2026-06-01T23:00:00Z', '45'],
      ['2026-06-02T00:00:00Z', '0'], // reset diario
      ['2026-06-02T01:00:00Z', '2'],
    ];
    const { points, stats } = applyMappingWithStats(rows, mapping({ valueKind: 'CUMULATIVE_DAILY' }));
    expect(stats.negativeDropped).toBe(0); // el reset se detecta por día, NO como negativo
    // diffs: (45-40)=5, reset salta, (2-0)=2
    const total = points.reduce((a, p) => a + p.kwh, 0);
    expect(total).toBeCloseTo(7, 6);
  });
});

describe('TC-INV-005 — huso local→UTC con DST', () => {
  it('Europe/Madrid verano (UTC+2) e invierno (UTC+1) → hora UTC correcta', () => {
    const summer = applyMapping(
      [['ts', 'v'], ['01/07/2026 14:00', '10']],
      mapping({ timeFormat: 'DD/MM/YYYY HH:mm', timezone: 'Europe/Madrid' }),
    );
    expect(summer[0].ts).toBe('2026-07-01T12:00:00.000Z'); // 14:00 local −2 = 12:00 UTC
    const winter = applyMapping(
      [['ts', 'v'], ['01/01/2026 14:00', '10']],
      mapping({ timeFormat: 'DD/MM/YYYY HH:mm', timezone: 'Europe/Madrid' }),
    );
    expect(winter[0].ts).toBe('2026-01-01T13:00:00.000Z'); // 14:00 local −1 = 13:00 UTC
  });
});

describe('TC-INV-006 — agregación 15min→hora', () => {
  it('4 muestras de 15 min → 1 punto horario (Σ energía)', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T10:00:00Z', '1'],
      ['2026-06-01T10:15:00Z', '1'],
      ['2026-06-01T10:30:00Z', '1'],
      ['2026-06-01T10:45:00Z', '1'],
    ];
    const { points, stats } = applyMappingWithStats(rows, mapping());
    expect(points).toHaveLength(1);
    expect(points[0].kwh).toBeCloseTo(4, 6);
    expect(stats.collapsedSamples).toBe(3); // 3 muestras cayeron en la hora ya abierta
  });
});

describe('TC-INV-007 — multi-inversor pivotado se suma', () => {
  it('N valueColumns → Σ por timestamp', () => {
    const rows = [
      ['ts', 'a', 'b'],
      ['2026-06-01T10:00:00Z', '5', '7'],
    ];
    const pts = applyMapping(rows, mapping({ valueColumns: ['a', 'b'] }));
    expect(pts[0].kwh).toBeCloseTo(12, 6);
  });
});

describe('TC-INV-008 — coma decimal y ; (fixture Huawei ES)', () => {
  it('parseNumber con decimal coma y miles punto', () => {
    expect(parseNumber('1.234,56', ',')).toBeCloseTo(1234.56, 6);
    expect(parseNumber('12,5 kWh', ',')).toBeCloseTo(12.5, 6);
    expect(parseNumber('1,234.56', '.')).toBeCloseTo(1234.56, 6);
  });

  it('normaliza el fixture FusionSolar ES (pivotado, ;, metadatos, tz Madrid)', () => {
    const rows = parseCsv(fixture('huawei-fusionsolar-es.csv'));
    // Mapeo confirmado: saltar 4 filas de metadatos (cabecera real en la fila "Tiempo;…"),
    // sumar los dos inversores, decimal coma, huso Madrid.
    const m = mapping({
      timeColumn: 'Tiempo',
      timeFormat: 'DD/MM/YYYY HH:mm',
      valueColumns: ['INV-A001 Rendimiento (kWh)', 'INV-A002 Rendimiento (kWh)'], // los dos inversores
      decimal: ',',
      timezone: 'Europe/Madrid',
      skipRows: 3,
    });
    const { points } = applyMappingWithStats(rows, m);
    expect(points.length).toBe(6);
    // primera hora 10:00 local Madrid (verano, −2) → 08:00 UTC; A001+A002 = 12,50+11,80 = 24,30
    expect(points[0].ts).toBe('2026-06-01T08:00:00.000Z');
    expect(points[0].kwh).toBeCloseTo(24.3, 6);
  });
});

describe('TC-INV-009 — detectMapping propone columnas y casa preset', () => {
  it('cabecera FusionSolar ES → propone tiempo/valor/huso y casa preset', () => {
    const rows = parseCsv(fixture('huawei-fusionsolar-es.csv'));
    const prop = detectMapping(rows);
    expect(prop.mapping.skipRows).toBeGreaterThanOrEqual(3); // salta metadatos de planta
    expect(prop.mapping.timeColumn.toLowerCase()).toContain('tiempo');
    expect(prop.mapping.decimal).toBe(',');
    expect(prop.mapping.valueKind).toBe('ENERGY_INTERVAL');
    // "Sum" presente → prefiere esa columna como valor único.
    expect(prop.mapping.valueColumns.length).toBe(1);
  });
});

describe('TC-INV-010 — detectMapping marca fecha ambigua', () => {
  it('03/04/2026 indistinguible día/mes → warning y confidence < 1', () => {
    const rows = [
      ['Fecha', 'Energy (kWh)'],
      ['03/04/2026 10:00', '5'],
      ['03/04/2026 11:00', '6'],
    ];
    const prop = detectMapping(rows);
    expect(prop.warnings.some(w => /ambig/i.test(w))).toBe(true);
    expect(prop.confidence).toBeLessThan(1);
  });
});

describe('TC-INV-013 — validate: cobertura, huecos, solape con consumo', () => {
  it('serie con hueco horario → coveragePct y hourGaps correctos', () => {
    const rows = [
      ['ts', 'v'],
      ['2026-06-01T10:00:00Z', '5'],
      ['2026-06-01T12:00:00Z', '5'], // falta las 11:00
    ];
    const { points, stats } = applyMappingWithStats(rows, mapping());
    const report = validate(points, mapping(), stats, {
      from: '2026-06-01T00:00:00Z',
      to: '2026-07-01T00:00:00Z',
    });
    expect(report.hourGaps).toBe(1);
    expect(report.coveragePct).toBeCloseTo((2 / 3) * 100, 4);
    expect(report.consumptionOverlapPct).toBe(100);
  });

  it('sin solape con consumo → warning y 0%', () => {
    const rows = [['ts', 'v'], ['2026-06-01T10:00:00Z', '5'], ['2026-06-01T11:00:00Z', '5']];
    const { points, stats } = applyMappingWithStats(rows, mapping());
    const report = validate(points, mapping(), stats, {
      from: '2025-01-01T00:00:00Z',
      to: '2025-02-01T00:00:00Z',
    });
    expect(report.consumptionOverlapPct).toBe(0);
    expect(report.warnings.some(w => /no solapa/i.test(w))).toBe(true);
  });
});
