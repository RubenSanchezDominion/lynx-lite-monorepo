// Interfaz del optimization-engine (SPECS §4.4). Cálculo puro, sin I/O.
// El resolver/data source de apps/api construye todos los agregados a partir de la curva
// `hourly_consumption` y `max_power` de InfluxDB y los pasa aquí.

export interface OptimizationInput {
  tariff: 'T_2_0TD' | 'T_3_0TD';
  granularity: 'hourly' | 'quarter';

  // Potencias contratadas actuales (kW). 2.0TD: { P1, P2 } | 3.0TD: { P1..P6 } (power periods)
  contractedPower: Record<string, number>;

  // Muestra de potencia derivada de la curva (kW), por power period.
  // El resolver la construye: kW = kWh / horasDelIntervalo, agrupado por período.
  powerSamplesByPeriod: Record<string, number[]>;

  // Percentil 99 mensual de la curva, por período y mes (sobredimensionamiento).
  // Clave externa: "YYYY-MM"; interna: power period → p99 de ese mes.
  monthlyP99ByPeriod: Record<string, Record<string, number>>;

  // Máximos mensuales reales (max_power), por período y mes (Pdp del exceso). Clave: "YYYY-MM".
  monthlyMaxByPeriod: Record<string, Record<string, number>>;

  // Días de facturación de cada mes de la ventana (n de la fórmula de excesos). Clave: "YYYY-MM".
  daysByMonth: Record<string, number>;

  // Control de potencia: 'ICP' → sin excesos (2.0TD); 'MAXIMETRO' → aplica computeExcessTerm.
  modePowerControl: 'ICP' | 'MAXIMETRO';

  // Fracción (0..1) de intervalos del mes con potencia > contratada, por período y mes.
  overContractedRatioByPeriod: Record<string, Record<string, number>>;

  // Tarifas de potencia (€/kW/día) por período. Origen: TollRate + ChargeRate (POWER).
  tollRatesPower: Record<string, number>;
  chargeRatesPower: Record<string, number>;

  // Término de exceso de potencia tepp4-5 (€/kW·día) por período. Origen: ExcessPowerRate.
  excessRatesPower: Record<string, number>;

  // Parámetros de configuración (con defaults si el resolver no los pasa)
  oversizeFactor?: number; // default 0.70 — umbral de sobredimensionamiento
  oversizeMonths?: number; // default 6    — meses consecutivos requeridos
  undersizeRatio?: number; // default 0.02 — fracción de intervalos en exceso
  minSavingEur?: number; // default 0      — ahorro mínimo para recommendChange=true

  // Restricción de un cambio/año
  lastPowerChangeDate: string | null; // ISO "YYYY-MM-DD" (Contract.validFrom más reciente)
  analysisTo: string; // ISO "YYYY-MM-DD" — fin de la ventana analizada
}

export interface OptimizationPeriod {
  period: number; // 1–6
  currentPower: number; // kW
  optimalPower: number; // kW
  p99Power: number; // kW
  observedMax: number; // kW
  diagnosis: 'OK' | 'OVERSIZED' | 'UNDERSIZED';
  marginPct: number; // %
}

export interface OptimizationResult {
  periods: OptimizationPeriod[];
  fixedSaving: number; // €/año
  excessSaving: number; // €/año
  annualSaving: number; // €/año
  recommendChange: boolean;
  changeAllowed: boolean;
  changeBlockedUntil: string | null; // ISO; null si changeAllowed
  upliftFactor: number; // 1.05 | 1.00
  sampleCount: number;
}
