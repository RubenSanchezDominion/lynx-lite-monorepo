// Interfaz del carbon-engine (SPECS §7.4). Cálculo puro, sin I/O y sin conocimiento de husos ni de
// la fuente del factor: el servicio de apps/api compone el factor de emisión horario (desde el mix de
// REData, gCO₂/kWh) y resuelve el mes local Madrid de cada hora antes de llamar aquí.

// Una hora de la curva de consumo, con su mes local ya resuelto.
export interface ConsumptionHour {
  ts: string; // ISO UTC, inicio de la hora
  month: string; // "YYYY-MM" local Madrid (resuelto por el servicio)
  kwh: number;
  gap: boolean; // imputado/estimado → marca de calidad
}

// Factor de emisión horario ya compuesto (Σ mix·coef), alineado por `ts` con el consumo.
export interface Co2FactorHour {
  ts: string; // ISO UTC
  gPerKwh: number; // gCO₂/kWh
}

export interface CarbonInput {
  consumption: ConsumptionHour[]; // ordenado por ts
  factors: Co2FactorHour[]; // mismo eje temporal que consumption
}

// Agregado mensual.
export interface CarbonMonthBucket {
  key: string; // "YYYY-MM"
  monthStart: string; // ISO UTC de la primera hora del mes (para ordenar la evolución)
  kwh: number;
  co2Kg: number;
  factorAvg: number; // factor medio del mes ponderado por consumo (gCO₂/kWh)
  hasGaps: boolean;
}

export interface CarbonResult {
  months: CarbonMonthBucket[]; // ordenados por monthStart (evolución temporal)
  totalKwh: number;
  totalCo2Kg: number;
  ownFactorGPerKwh: number; // factor propio ponderado por consumo
  nationalAvgFactorGPerKwh: number; // media temporal del factor en el periodo
  deltaPct: number; // (own − national) / national
  hasGaps: boolean;
}
