// Tipos del mapeador universal de ingesta de inversor FV (SPECS §8.12, M06.3). Puro, sin I/O.
// El reto del módulo es que cada portal de inversor (Huawei FusionSolar, Fronius, SolarEdge, Enphase,
// Victron, Solis…) exporta distinto. En vez de una clase por marca, hay UN normalizador parametrizado
// por un objeto `ColumnMapping`: la "estrategia por marca" son DATOS (un preset), no código.

// Qué representa la columna de valor del fichero crudo.
export type ValueKind =
  | 'ENERGY_INTERVAL' // kWh ya por intervalo (se toma directo, solo escala de unidad)
  | 'POWER' // potencia instantánea (kW/W) → integrar por el paso temporal (kW × Δt_horas)
  | 'CUMULATIVE_TOTAL' // contador de por vida, monótono creciente → diferenciar
  | 'CUMULATIVE_DAILY'; // contador del día, resetea a 0 a medianoche local → diferenciar, descartar reset

// Mapeo de columnas: qué es cada columna y cómo interpretarla. Lo propone `detectMapping` y lo confirma
// el usuario en el front antes de normalizar.
export interface ColumnMapping {
  timeColumn: string; // nombre de cabecera (o índice "0","1"… si no hay cabecera) de la columna de tiempo
  timeFormat?: string; // formato detectado: "ISO" | "EPOCH_S" | "EPOCH_MS" | patrón tipo "DD/MM/YYYY HH:mm"
  valueColumns: string[]; // 1..N columnas de valor; N inversores → se SUMAN por timestamp
  valueKind: ValueKind;
  unitScaleToKwh: number; // factor a kWh (energía) o a kW (potencia): kWh/kW→1, Wh/W→0.001, MWh→1000
  decimal: ',' | '.'; // separador decimal del fichero
  timezone: string; // IANA del huso del export (p. ej. "Europe/Madrid"); se convierte a UTC
  skipRows: number; // filas de metadatos de planta antes de la cabecera
}

export interface MappingProposal {
  mapping: ColumnMapping; // propuesta editable
  confidence: number; // 0..1 (heurística global)
  presetMatched?: string; // nombre del preset semilla que casó, si alguno
  warnings: string[]; // ambigüedades detectadas (p. ej. fecha día/mes indistinguible)
}

// Punto canónico: energía (kWh) de UNA hora, en UTC. Es lo que consume el resto de LYNX (cruce con
// `hourly_consumption`, que también es horario UTC).
export interface CanonicalPoint {
  ts: string; // ISO UTC, alineado a la hora en punto (minutos/segundos = 0)
  kwh: number;
}

// Preset semilla por marca (datos, no código). `headerHints` casan contra las cabeceras del fichero.
export interface InverterPreset {
  name: string; // "huawei-fusionsolar", "fronius-solarweb", …
  label: string; // legible
  headerHints: string[]; // subcadenas (lowercase) que delatan esta marca en alguna cabecera
  defaults: Partial<ColumnMapping>; // valores por defecto que la detección aplica si casa el preset
}

export interface ValidationReport {
  rowsParsed: number;
  rowsSkipped: number;
  rangeStart: string; // ISO UTC ("" si no hay puntos)
  rangeEnd: string;
  detectedUnit: ValueKind;
  detectedTimezone: string;
  hourGaps: number; // horas sin dato dentro del rango [start, end]
  duplicates: number; // timestamps repetidos que se colapsaron
  negativeDropped: number; // diffs negativas descartadas (resets de acumulado)
  coveragePct: number; // % de horas con dato sobre el rango
  consumptionOverlapPct: number; // % del rango que solapa con la curva de consumo (cruce útil)
  warnings: string[];
}

export interface PerformanceInput {
  measured: CanonicalPoint[]; // serie real medida (kWh/hora UTC)
  expected: CanonicalPoint[]; // baseline PVGIS alineado (kWh/hora UTC)
  kwp: number; // potencia pico instalada (para kWh/kWp)
  underperformanceThreshold?: number; // def 0.85
}

export interface MonthPerformance {
  key: string; // "YYYY-MM"
  measuredKwh: number;
  expectedKwh: number;
  ratio: number; // measured / expected del mes (0 si expected = 0)
}

export interface PerformanceResult {
  measuredKwh: number;
  expectedKwh: number;
  performanceRatio: number; // measured / expected (1 = según diseño; <1 infraproduce)
  specificYieldKwhPerKwp: number; // measuredKwh / kwp
  months: MonthPerformance[];
  underperforming: boolean; // performanceRatio < umbral
  underperformancePct: number; // max(0, 1 − performanceRatio) × 100
}
