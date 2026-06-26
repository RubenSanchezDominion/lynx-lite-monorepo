import type { ColumnMapping, InverterPreset, MappingProposal, ValueKind } from './types.js';
import { SEED_PRESETS } from './presets.js';

// Heurística de auto-detección del mapeo a partir de las primeras filas crudas. PROPONE (no impone): el
// usuario confirma/corrige en el front. Toda la lógica difícil (huso, unidades, agregación) vive en
// applyMapping; aquí solo se adivina qué columna es qué.

// Diccionario multiidioma/multimarca de nombres de columna de VALOR (lowercase, subcadena).
const VALUE_HINTS = [
  'energy', 'energía', 'energia', 'yield', 'rendimiento', 'production', 'producción', 'produccion',
  'generation', 'generación', 'generacion', 'kwh', 'wh', 'mwh', 'ac_power', 'ac power', 'pac',
  'active power', 'power', 'potencia', 'egen', 'pv',
];
const POWER_HINTS = ['ac_power', 'ac power', 'pac', 'active power', 'power(kw)', 'power (kw)', 'potencia'];
const CUM_TOTAL_HINTS = ['total_yield', 'total yield', 'lifetime', 'total production', 'acumulada', 'contador'];
const CUM_DAILY_HINTS = ['daily_yield', 'daily yield', 'day production', 'producción diaria', 'diaria'];
const TIME_HINTS = ['time', 'date', 'fecha', 'hora', 'timestamp', 'datetime', 'date_time', 'date/time'];

function lc(s: string): string {
  return s.trim().toLowerCase();
}
function matchesAny(s: string, hints: string[]): boolean {
  const l = lc(s);
  return hints.some(h => l.includes(h));
}

// ¿Esta celda parece un timestamp (fecha y/u hora)? Para distinguir filas de DATOS de las de cabecera.
function looksLikeTime(cell: string): boolean {
  const s = cell.trim();
  if (s === '') return false;
  return /^\d{10,13}$/.test(s) || /\d{4}-\d{2}-\d{2}/.test(s) || /\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(s) || /\d{1,2}:\d{2}/.test(s);
}

// Localiza la fila de CABECERA y devuelve cuántas filas de metadatos hay antes (skipRows). Los portales
// (Huawei/SolarEdge) meten líneas de planta arriba que TAMBIÉN son texto, así que no basta con "texto":
// la cabecera real es la última fila no-temporal JUSTO ANTES de que empiecen los datos (filas cuya
// primera columna parsea como tiempo). Si no hay datos temporales, cae a la primera fila.
function findHeaderRow(rawRows: string[][]): number {
  const limit = Math.min(rawRows.length, 30);
  for (let i = 1; i < limit; i++) {
    const firstCell = rawRows[i][0] ?? '';
    const prevFirst = rawRows[i - 1][0] ?? '';
    if (looksLikeTime(firstCell) && !looksLikeTime(prevFirst)) {
      return i - 1; // la fila anterior al primer dato temporal es la cabecera
    }
  }
  // Sin transición clara: primera fila con ≥2 celdas de texto.
  for (let i = 0; i < limit; i++) {
    const nonNumeric = rawRows[i].filter(c => c.trim() !== '' && !/^[\d.,\s+\-:/]+$/.test(c.trim())).length;
    if (nonNumeric >= 2) return i;
  }
  return 0;
}

// Detecta el formato de tiempo de una columna a partir de sus valores. Marca ambigüedad día/mes.
function detectTimeFormat(values: string[]): { format: string; warning?: string } {
  const sample = values.find(v => v.trim() !== '') ?? '';
  const s = sample.trim();
  if (/^\d{10}$/.test(s)) return { format: 'EPOCH_S' };
  if (/^\d{13}$/.test(s)) return { format: 'EPOCH_MS' };
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(s) || /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return { format: 'ISO' };

  // DD/MM o MM/DD: si algún valor tiene primer componente > 12, es day-first inequívoco.
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/;
  let dayFirstSure = false;
  let ambiguous = false;
  for (const v of values) {
    const m = v.trim().match(dmy);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) dayFirstSure = true;
    else if (b > 12) {
      /* month-first seguro */
    } else ambiguous = true;
  }
  const hasTime = /\d{1,2}:\d{2}/.test(s);
  const timeSuffix = hasTime ? ' HH:mm' : '';
  if (dayFirstSure || ambiguous) {
    return {
      format: `DD/MM/YYYY${timeSuffix}`,
      warning: ambiguous && !dayFirstSure ? 'Formato de fecha día/mes ambiguo; asumido día primero (DD/MM). Confírmalo.' : undefined,
    };
  }
  if (/^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}/.test(s)) return { format: `YYYY/MM/DD${timeSuffix}` };
  return { format: `DD/MM/YYYY${timeSuffix}`, warning: 'No se pudo determinar el formato de fecha con certeza; confírmalo.' };
}

function detectValueKind(headerName: string): ValueKind {
  if (matchesAny(headerName, CUM_DAILY_HINTS)) return 'CUMULATIVE_DAILY';
  if (matchesAny(headerName, CUM_TOTAL_HINTS)) return 'CUMULATIVE_TOTAL';
  if (matchesAny(headerName, POWER_HINTS)) return 'POWER';
  return 'ENERGY_INTERVAL';
}

function detectUnitScale(headerName: string, kind: ValueKind): number {
  const l = lc(headerName);
  if (l.includes('mwh') || l.includes('mw')) return 1000;
  if ((l.includes('wh') && !l.includes('kwh')) || (/\bw\b/.test(l) && !l.includes('kw'))) return 0.001;
  return 1; // kWh / kW
}

function matchPreset(header: string[], presets: InverterPreset[]): InverterPreset | undefined {
  const joined = header.map(lc).join(' | ');
  return presets.find(p => p.headerHints.some(h => joined.includes(h)));
}

export function detectMapping(rawRows: string[][], presets: InverterPreset[] = SEED_PRESETS): MappingProposal {
  const warnings: string[] = [];
  if (rawRows.length === 0) {
    return {
      mapping: { timeColumn: '', valueColumns: [], valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
      confidence: 0,
      warnings: ['Fichero vacío.'],
    };
  }

  const skipRows = findHeaderRow(rawRows);
  const header = rawRows[skipRows];
  const dataRows = rawRows.slice(skipRows + 1);
  const preset = matchPreset(header, presets);

  // Columna de tiempo: por nombre, o la que mejor parsee como fecha.
  let timeIdx = header.findIndex(h => matchesAny(h, TIME_HINTS));
  if (timeIdx < 0) {
    timeIdx = header.findIndex((_, i) => {
      const vals = dataRows.slice(0, 20).map(r => r[i] ?? '');
      const ok = vals.filter(v => /\d{4}|\d{1,2}[/\-.]\d{1,2}/.test(v) && /\d/.test(v)).length;
      return ok > vals.length * 0.5;
    });
  }
  if (timeIdx < 0) timeIdx = 0;

  // Columnas de valor: las que casan el diccionario; si ninguna, las numéricas que no sean la de tiempo.
  // En layout pivotado (Huawei) hay una por inversor + "Sum": si existe "Sum"/"total", se prefiere esa.
  let valueIdxs: number[] = header
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => i !== timeIdx && matchesAny(h, VALUE_HINTS))
    .map(({ i }) => i);

  const sumIdx = header.findIndex((h, i) => i !== timeIdx && /\b(sum|suma|total|plant)\b/i.test(h));
  if (sumIdx >= 0) valueIdxs = [sumIdx];

  if (valueIdxs.length === 0) {
    valueIdxs = header
      .map((_, i) => i)
      .filter(i => i !== timeIdx)
      .filter(i => {
        const vals = dataRows.slice(0, 20).map(r => r[i] ?? '');
        const numeric = vals.filter(v => /^[\d.,\s+\-eE]+$/.test(v.trim()) && /\d/.test(v)).length;
        return numeric > vals.length * 0.6;
      });
    if (valueIdxs.length > 0) warnings.push('No se reconoció el nombre de la columna de energía; usadas las columnas numéricas. Confírmalo.');
  }

  const valueHeader = valueIdxs.length ? header[valueIdxs[0]] : '';
  const kind = (preset?.defaults.valueKind as ValueKind) ?? detectValueKind(valueHeader);
  const { format, warning: timeWarn } = detectTimeFormat(dataRows.slice(0, 30).map(r => r[timeIdx] ?? ''));
  if (timeWarn) warnings.push(timeWarn);

  // Separador decimal: si algún valor tiene "1.234,5" o coma como último separador → coma.
  const decimal = detectDecimal(dataRows, valueIdxs) ?? (preset?.defaults.decimal as ',' | '.') ?? '.';

  const mapping: ColumnMapping = {
    timeColumn: header[timeIdx] ?? String(timeIdx),
    timeFormat: format,
    valueColumns: valueIdxs.map(i => header[i] ?? String(i)),
    valueKind: kind,
    unitScaleToKwh: (preset?.defaults.unitScaleToKwh as number) ?? detectUnitScale(valueHeader, kind),
    decimal,
    timezone: (preset?.defaults.timezone as string) ?? 'Europe/Madrid',
    skipRows,
  };

  // Confianza: combina si casó preset, si reconoció columna de valor por nombre y si la fecha es clara.
  let confidence = 0.4;
  if (preset) confidence += 0.25;
  if (matchesAny(valueHeader, VALUE_HINTS)) confidence += 0.2;
  if (!timeWarn) confidence += 0.15;
  confidence = Math.min(1, confidence);
  if (valueIdxs.length === 0) confidence = Math.min(confidence, 0.3);

  return { mapping, confidence, presetMatched: preset?.name, warnings };
}

function detectDecimal(dataRows: string[][], valueIdxs: number[]): ',' | '.' | null {
  for (const r of dataRows.slice(0, 30)) {
    for (const i of valueIdxs) {
      const v = (r[i] ?? '').trim();
      if (/\d+\.\d{3},\d/.test(v) || /^\d{1,3}(\.\d{3})+,\d+$/.test(v) || /^\d+,\d+$/.test(v)) return ',';
      if (/^\d{1,3}(,\d{3})+\.\d+$/.test(v) || /^\d+\.\d+$/.test(v)) return '.';
    }
  }
  return null;
}
