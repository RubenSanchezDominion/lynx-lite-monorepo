import type {
  ConsumptionHour,
  GranularityName,
  KpiBucket,
  KpiInput,
  KpiIntervalResult,
  KpiResult,
  ProductionInterval,
} from './types.js';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 86_400_000;

// Solape en milisegundos de dos intervalos [aS, aE) y [bS, bE). 0 si no solapan.
export function overlapMs(aS: number, aE: number, bS: number, bE: number): number {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

// Mediana (robusta a outliers). 0 si no hay muestras.
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Año-semana ISO 8601 a partir de una fecha local (la semana 1 contiene el primer jueves del año).
function isoWeekParts(y: number, m: number, d: number): { isoYear: number; week: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // lunes = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // jueves de esa semana
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / WEEK_MS);
  return { isoYear, week };
}

// Clave de bucket según la granularidad, derivada de la hora LOCAL del tramo (Madrid).
function bucketKeyOf(p: ProductionInterval, granularity: GranularityName): string {
  const ls = p.localStart;
  const y = ls.slice(0, 4);
  const mo = ls.slice(5, 7);
  const da = ls.slice(8, 10);
  switch (granularity) {
    case 'DAY':
      return `${y}-${mo}-${da}`;
    case 'MONTH':
      return `${y}-${mo}`;
    case 'SHIFT':
      return `${y}-${mo}-${da}#${p.shift ?? 'SIN'}`;
    case 'WEEK': {
      const { isoYear, week } = isoWeekParts(Number(y), Number(mo), Number(da));
      return `${isoYear}-W${String(week).padStart(2, '0')}`;
    }
  }
}

// Cálculo puro del KPI €/unidad (SPECS §6.4). Sin redondeo intermedio. El engine no conoce
// tarifas (recibe `eurPerKwh` ya compuesto) ni husos horarios (recibe `localStart` resuelto).
export function computeKpi(input: KpiInput): KpiResult {
  // Precalcula los límites de cada bucket de consumo una sola vez.
  const cons = input.consumption.map(h => {
    const s = Date.parse(h.ts);
    return { s, e: s + h.hours * HOUR_MS, kwh: h.kwh, eur: h.eurPerKwh, gap: h.gap };
  });

  // Paso 1–2 — imputación proporcional + €/unidad por tramo.
  const intervals: KpiIntervalResult[] = input.production.map(p => {
    const ps = Date.parse(p.startTs);
    const pe = Date.parse(p.endTs);
    let kwh = 0;
    let costEur = 0;
    let hasGap = false;
    for (const h of cons) {
      const ov = overlapMs(ps, pe, h.s, h.e);
      if (ov <= 0) continue;
      const frac = ov / (h.e - h.s);
      kwh += h.kwh * frac;
      costEur += h.kwh * frac * h.eur;
      if (h.gap) hasGap = true;
    }
    return {
      startTs: p.startTs,
      endTs: p.endTs,
      units: p.units,
      shift: p.shift ?? null,
      line: p.line ?? null,
      batch: p.batch ?? null,
      kwh,
      costEur,
      eurPerUnit: p.units > 0 ? costEur / p.units : 0,
      hasGap,
    };
  });

  // Paso 3 — agregación por granularidad (se suman coste y unidades; se divide al final).
  const acc = new Map<string, { key: string; startMs: number; units: number; kwh: number; cost: number }>();
  input.production.forEach((p, i) => {
    const key = bucketKeyOf(p, input.granularity);
    const r = intervals[i];
    const startMs = Date.parse(p.startTs);
    const cur = acc.get(key) ?? { key, startMs, units: 0, kwh: 0, cost: 0 };
    cur.units += r.units;
    cur.kwh += r.kwh;
    cur.cost += r.costEur;
    if (startMs < cur.startMs) cur.startMs = startMs;
    acc.set(key, cur);
  });

  const buckets: KpiBucket[] = [...acc.values()]
    .map(b => ({
      key: b.key,
      bucketStart: new Date(b.startMs).toISOString(),
      units: b.units,
      kwh: b.kwh,
      costEur: b.cost,
      eurPerUnit: b.units > 0 ? b.cost / b.units : 0,
      isOutlier: false,
    }))
    .sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart));

  // Paso 4 — baseline (mediana) + outliers ±outlierPct.
  const baselineEurPerUnit = median(buckets.map(b => b.eurPerUnit));
  for (const b of buckets) {
    b.isOutlier =
      baselineEurPerUnit > 0 &&
      Math.abs(b.eurPerUnit - baselineEurPerUnit) > input.outlierPct * baselineEurPerUnit;
  }

  // Paso 5 — totales.
  const totalUnits = intervals.reduce((a, r) => a + r.units, 0);
  const totalKwh = intervals.reduce((a, r) => a + r.kwh, 0);
  const totalCostEur = intervals.reduce((a, r) => a + r.costEur, 0);

  return {
    intervals,
    buckets,
    baselineEurPerUnit,
    totalUnits,
    totalKwh,
    totalCostEur,
    avgEurPerUnit: totalUnits > 0 ? totalCostEur / totalUnits : 0,
    hasGaps: intervals.some(r => r.hasGap),
  };
}
