import type { CanonicalPoint, ColumnMapping, ValidationReport } from './types.js';
import type { NormalizeStats } from './normalize.js';

const HOUR_MS = 3_600_000;

// Construye el informe de validación a partir de la serie canónica ya normalizada y las estadísticas
// que expone el normalizador. No re-normaliza: el normalizador es la única fuente de verdad.
export function validate(
  points: CanonicalPoint[],
  mapping: ColumnMapping,
  stats: NormalizeStats,
  consumptionRange?: { from: string; to: string },
): ValidationReport {
  const warnings: string[] = [];

  if (points.length === 0) {
    return {
      rowsParsed: stats.rowsParsed,
      rowsSkipped: stats.rowsSkipped,
      rangeStart: '',
      rangeEnd: '',
      detectedUnit: mapping.valueKind,
      detectedTimezone: mapping.timezone,
      hourGaps: 0,
      duplicates: stats.collapsedSamples,
      negativeDropped: stats.negativeDropped,
      coveragePct: 0,
      consumptionOverlapPct: 0,
      warnings: ['La serie normalizada quedó vacía: revisa el mapeo (columna de tiempo/valor, formato de fecha).'],
    };
  }

  const startMs = Date.parse(points[0].ts);
  const endMs = Date.parse(points[points.length - 1].ts);
  const expectedHours = Math.floor((endMs - startMs) / HOUR_MS) + 1;
  const presentHours = points.length;
  const hourGaps = Math.max(0, expectedHours - presentHours);
  const coveragePct = expectedHours > 0 ? (presentHours / expectedHours) * 100 : 100;

  // Solape con la curva de consumo: cuánto del rango medido cae dentro del rango con consumo disponible.
  let consumptionOverlapPct = 0;
  if (consumptionRange) {
    const cFrom = Date.parse(consumptionRange.from);
    const cTo = Date.parse(consumptionRange.to);
    const oStart = Math.max(startMs, cFrom);
    const oEnd = Math.min(endMs, cTo);
    const overlap = Math.max(0, oEnd - oStart);
    const span = endMs - startMs;
    consumptionOverlapPct = span > 0 ? (overlap / span) * 100 : oEnd >= oStart ? 100 : 0;
    if (consumptionOverlapPct === 0) {
      warnings.push('La serie del inversor no solapa con la curva de consumo: no hay tramo común para cruzar autoconsumo.');
    }
  }

  if (coveragePct < 80) warnings.push(`Cobertura ${coveragePct.toFixed(0)}%: faltan horas en el rango (${hourGaps} huecos).`);
  if (stats.collapsedSamples > 0) warnings.push(`${stats.collapsedSamples} muestras cayeron en horas ya ocupadas (se sumaron).`);
  if (stats.negativeDropped > 0 && (mapping.valueKind === 'ENERGY_INTERVAL' || mapping.valueKind === 'POWER')) {
    warnings.push('Se descartaron valores negativos en una serie que no es de contador: revisa la unidad.');
  }

  return {
    rowsParsed: stats.rowsParsed,
    rowsSkipped: stats.rowsSkipped,
    rangeStart: points[0].ts,
    rangeEnd: points[points.length - 1].ts,
    detectedUnit: mapping.valueKind,
    detectedTimezone: mapping.timezone,
    hourGaps,
    duplicates: stats.collapsedSamples,
    negativeDropped: stats.negativeDropped,
    coveragePct,
    consumptionOverlapPct,
    warnings,
  };
}
