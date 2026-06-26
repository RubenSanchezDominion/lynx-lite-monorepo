import type { CanonicalPoint, ColumnMapping } from './types.js';
import { parseTimeToUtcMs, floorToHourUtc, dayKeyLocal } from './time.js';

const HOUR_MS = 3_600_000;

// Parsea un número respetando el separador decimal del fichero. Con `decimal=','`, los puntos son
// separadores de millar y la coma es el decimal ("1.234,56" → 1234.56). Con `decimal='.'`, al revés.
export function parseNumber(raw: string, decimal: ',' | '.'): number | null {
  let s = raw.trim();
  if (s === '') return null;
  // Quita comillas y unidades pegadas ("12,5 kWh" → "12,5").
  s = s.replace(/["']/g, '').replace(/[^\d.,+\-eE]+/g, '');
  if (s === '') return null;
  if (decimal === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Resuelve el índice de una columna por nombre de cabecera o por índice numérico ("0","1"…).
function resolveColIndex(header: string[], col: string): number {
  const byName = header.findIndex(h => h.trim() === col.trim());
  if (byName >= 0) return byName;
  const asIdx = Number(col);
  return Number.isInteger(asIdx) && asIdx >= 0 && asIdx < header.length ? asIdx : -1;
}

// Fila intermedia: instante UTC + suma de los valores de las columnas de inversor.
interface Sample {
  utcMs: number;
  value: number; // suma de valueColumns (potencia, energía o lectura de contador, según valueKind)
}

// Estadísticas de la normalización, para el informe de validación.
export interface NormalizeStats {
  rowsParsed: number; // filas de datos que parsearon (tiempo + ≥1 valor)
  rowsSkipped: number; // filas de datos descartadas (no parseaban)
  negativeDropped: number; // diffs negativas descartadas (resets de acumulado)
  collapsedSamples: number; // muestras distintas que cayeron en una hora ya ocupada (duplicados)
}

// Normaliza filas crudas → serie horaria canónica (kWh/hora UTC). Orden de operaciones de §8.12.3:
// saltar metadatos → parsear (tiempo→UTC, valores→número) → transformar según valueKind → sumar
// inversores → agregar a hora entera. Determinista y puro. Atajo cuando no se necesitan stats.
export function applyMapping(rawRows: string[][], mapping: ColumnMapping): CanonicalPoint[] {
  return applyMappingWithStats(rawRows, mapping).points;
}

// Variante que además devuelve las estadísticas (para validate()).
export function applyMappingWithStats(
  rawRows: string[][],
  mapping: ColumnMapping,
): { points: CanonicalPoint[]; stats: NormalizeStats } {
  const empty: NormalizeStats = { rowsParsed: 0, rowsSkipped: 0, negativeDropped: 0, collapsedSamples: 0 };
  const rows = rawRows.slice(mapping.skipRows);
  if (rows.length === 0) return { points: [], stats: empty };
  const header = rows[0];
  const dataRows = rows.slice(1);

  const tIdx = resolveColIndex(header, mapping.timeColumn);
  const vIdxs = mapping.valueColumns.map(c => resolveColIndex(header, c)).filter(i => i >= 0);
  if (tIdx < 0 || vIdxs.length === 0) {
    return { points: [], stats: { ...empty, rowsSkipped: dataRows.length } };
  }

  // 1) Parsear cada fila a (utcMs, valor sumado de inversores).
  const samples: Sample[] = [];
  let rowsSkipped = 0;
  for (const row of dataRows) {
    const utcMs = parseTimeToUtcMs(row[tIdx] ?? '', mapping.timeFormat, mapping.timezone);
    if (utcMs === null) {
      rowsSkipped++;
      continue;
    }
    let value = 0;
    let any = false;
    for (const vi of vIdxs) {
      const n = parseNumber(row[vi] ?? '', mapping.decimal);
      if (n !== null) {
        value += n;
        any = true;
      }
    }
    if (any) samples.push({ utcMs, value });
    else rowsSkipped++;
  }
  samples.sort((a, b) => a.utcMs - b.utcMs);
  const rowsParsed = samples.length;
  if (samples.length === 0) return { points: [], stats: { ...empty, rowsSkipped } };

  // 2) Transformar valor → energía (kWh) por muestra; `negativeDropped` cuenta resets descartados.
  const { energy, negativeDropped } = toEnergyPerSample(samples, mapping);

  // 3) Agregar a hora entera UTC (Σ energía del bucket); cuenta cuántas muestras colapsaron en una hora.
  const byHour = new Map<number, number>();
  let collapsedSamples = 0;
  for (const e of energy) {
    const h = floorToHourUtc(e.utcMs);
    if (byHour.has(h)) collapsedSamples++;
    byHour.set(h, (byHour.get(h) ?? 0) + e.kwh);
  }
  const points = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, kwh]) => ({ ts: new Date(ms).toISOString(), kwh }));

  return { points, stats: { rowsParsed, rowsSkipped, negativeDropped, collapsedSamples } };
}

interface SampleEnergy {
  utcMs: number;
  kwh: number;
}

// Convierte cada muestra a kWh según el tipo de valor. Devuelve también cuántas diffs negativas se
// descartaron (resets de contador) para el informe de validación.
export function toEnergyPerSample(
  samples: Sample[],
  mapping: ColumnMapping,
): { energy: SampleEnergy[]; negativeDropped: number } {
  const { valueKind, unitScaleToKwh, timezone } = mapping;
  const out: SampleEnergy[] = [];
  let negativeDropped = 0;

  if (valueKind === 'ENERGY_INTERVAL') {
    for (const s of samples) {
      const kwh = s.value * unitScaleToKwh;
      if (kwh < 0) negativeDropped++;
      else out.push({ utcMs: s.utcMs, kwh });
    }
    return { energy: out, negativeDropped };
  }

  if (valueKind === 'POWER') {
    // Energía = potencia media del tramo × Δt. Δt = separación a la muestra SIGUIENTE (la potencia rige
    // hasta la próxima lectura). La última muestra usa el paso modal de la serie.
    const step = modalStepMs(samples);
    for (let i = 0; i < samples.length; i++) {
      const dtMs = i + 1 < samples.length ? samples[i + 1].utcMs - samples[i].utcMs : step;
      const dtH = dtMs / HOUR_MS;
      const kwh = samples[i].value * unitScaleToKwh * dtH;
      if (kwh < 0) negativeDropped++;
      else out.push({ utcMs: samples[i].utcMs, kwh });
    }
    return { energy: out, negativeDropped };
  }

  // CUMULATIVE_TOTAL / CUMULATIVE_DAILY: energía = diferencia entre lecturas consecutivas. La energía
  // se atribuye al instante de la lectura ACTUAL (lo producido desde la previa hasta ahora).
  let prev: number | null = null;
  let prevDay: string | null = null;
  for (const s of samples) {
    const day = dayKeyLocal(s.utcMs, timezone);
    const reset = valueKind === 'CUMULATIVE_DAILY' && prevDay !== null && day !== prevDay;
    if (prev !== null && !reset) {
      const diff = (s.value - prev) * unitScaleToKwh;
      if (diff >= 0) out.push({ utcMs: s.utcMs, kwh: diff });
      else negativeDropped++; // reset de contador o corrección → se descarta
    }
    prev = s.value;
    prevDay = day;
  }
  return { energy: out, negativeDropped };
}

// Paso temporal MODAL (más frecuente) de la serie en ms. Robusto a huecos sueltos.
function modalStepMs(samples: Sample[]): number {
  if (samples.length < 2) return HOUR_MS;
  const counts = new Map<number, number>();
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].utcMs - samples[i - 1].utcMs;
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = HOUR_MS;
  let bestC = 0;
  for (const [d, c] of counts) if (c > bestC) ((best = d), (bestC = c));
  return best;
}
