// Interfaz del alerts-engine (SPECS §5.4). Detección pura, sin I/O.
// El job / data source de apps/api construye los intervalos del día y la referencia
// de 13 semanas a partir de `hourly_consumption` (InfluxDB) y los pasa aquí.

export type AlertTypeName = 'ZSCORE' | 'PHANTOM' | 'LIMIT' | 'ESTIMATED';
export type SensitivityName = 'CONSERVADOR' | 'EQUILIBRADO' | 'AGRESIVO';
export type SeverityName = 'INFO' | 'WARNING' | 'CRITICAL';

// Un intervalo de la curva (1 h o 15 min) ya etiquetado con su hora/día local y período.
export interface AlertInterval {
  ts: string; // ISO UTC, inicio del intervalo
  localHour: number; // 0–23 hora local Madrid
  weekday: number; // 0–6 (0 = domingo) hora local
  period: number; // 1–6 (período tarifario del intervalo)
  kwh: number;
  estimated: boolean; // DATADIS devolvió obtainMethod="Estimada"
  gap: boolean; // estimado o imputado (no facturable). Los detectores de consumo lo ignoran.
}

// Franja de inactividad declarada por el cliente (hora local Madrid). `from`/`to` en "HH:MM".
export interface InactivityWindow {
  days: number[]; // 0–6
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}

export interface AlertDetectionConfig {
  enabledTypes: AlertTypeName[];
  sensitivity: SensitivityName;
  limitThresholdPct: number; // fracción de la potencia contratada (LIMIT)
  phantomThresholdKwh: number; // consumo mínimo en franja inactiva para PHANTOM
  inactivityWindows: InactivityWindow[];
}

export interface AlertDetectionInput {
  targetDay: AlertInterval[]; // intervalos del día evaluado
  referenceBySlot: Record<string, number[]>; // "DOW-HH" → kWh de las 13 semanas previas (gap=false)
  contractedPower: Record<string, number>; // por período "P1".."P6" (kW) — para LIMIT
  intervalHours: number; // 1 | 0.25
  config: AlertDetectionConfig;
}

export interface DetectedAlert {
  type: AlertTypeName;
  severity: SeverityName;
  period: number; // 1–6
  windowStart: string; // ISO UTC
  windowEnd: string; // ISO UTC
  observedValue: number;
  expectedValue: number | null;
  deviation: number | null; // z-score o ratio sobre el umbral
  message: string;
}
