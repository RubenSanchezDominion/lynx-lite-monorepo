// Interfaz del kpi-engine (SPECS §6.4). Cálculo puro, sin I/O y sin conocimiento de tarifas:
// el servicio de apps/api compone el €/kWh (PVPC + peaje + cargo de energía, idéntico a M01) y
// resuelve la hora local Madrid de cada tramo antes de llamar aquí.

export type ShiftName = 'M' | 'T' | 'N';
export type GranularityName = 'SHIFT' | 'DAY' | 'WEEK' | 'MONTH';

// Un bucket de la curva de consumo (1 h o 15 min) con su precio ya compuesto.
export interface ConsumptionHour {
  ts: string; // ISO UTC, inicio del bucket
  hours: number; // duración en horas (1 | 0.25)
  kwh: number;
  eurPerKwh: number; // pvpc + peajeE[p] + cargoE[p], compuesto fuera del engine
  gap: boolean; // imputado/estimado (no facturable) → marca de calidad
}

// Un tramo de producción del fichero subido. `localStart` es la hora de pared en Europe/Madrid
// ("YYYY-MM-DDTHH:mm:ss"), resuelta por el servicio, y gobierna la agregación por día/semana/mes/turno.
export interface ProductionInterval {
  startTs: string; // ISO UTC
  endTs: string; // ISO UTC (endTs > startTs garantizado por validación previa)
  localStart: string; // "YYYY-MM-DDTHH:mm:ss" hora local Madrid del inicio
  units: number; // > 0 garantizado por validación previa
  shift?: ShiftName;
  line?: string;
  batch?: string;
}

export interface KpiInput {
  production: ProductionInterval[];
  consumption: ConsumptionHour[]; // ordenada por ts, cubre el rango
  granularity: GranularityName;
  outlierPct: number; // umbral relativo de outlier (p. ej. 0.20)
}

// Resultado por tramo de producción.
export interface KpiIntervalResult {
  startTs: string;
  endTs: string;
  units: number;
  shift: ShiftName | null;
  line: string | null;
  batch: string | null;
  kwh: number;
  costEur: number;
  eurPerUnit: number;
  hasGap: boolean; // algún bucket imputado con gap=true
}

// Agregado por granularidad temporal.
export interface KpiBucket {
  key: string; // "YYYY-MM-DD#M" | "YYYY-MM-DD" | "YYYY-Www" | "YYYY-MM"
  bucketStart: string; // ISO UTC del primer tramo del bucket (para ordenar la evolución)
  units: number;
  kwh: number;
  costEur: number;
  eurPerUnit: number;
  isOutlier: boolean;
}

export interface KpiResult {
  intervals: KpiIntervalResult[];
  buckets: KpiBucket[]; // ordenados por bucketStart (evolución temporal)
  baselineEurPerUnit: number; // mediana de buckets[].eurPerUnit
  totalUnits: number;
  totalKwh: number;
  totalCostEur: number;
  avgEurPerUnit: number;
  hasGaps: boolean;
}
