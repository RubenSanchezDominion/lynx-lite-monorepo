// Interfaz del solar-engine (SPECS §8.4). Cálculo puro, sin I/O y sin conocimiento de husos, tarifas
// ni del perfil intradía: el servicio de apps/api reparte la producción mensual de PVGIS a horas
// (perfil solar), compone el €/kWh (idéntico a M01) y resuelve el mes local antes de llamar aquí.

// Una hora con consumo real, producción solar ya repartida y precio de energía ya compuesto.
export interface SolarHour {
  ts: string; // ISO UTC
  month: string; // "YYYY-MM" local (para los buckets mensuales)
  consumptionKwh: number;
  productionKwh: number; // E_m repartido a esta hora (perfil solar)
  eurPerKwh: number; // pvpc + peajeE[p] + cargoE[p], ya compuesto (coste evitado)
}

export interface SolarInput {
  hours: SolarHour[]; // ordenado por ts, cubre el rango
  surplusCompensationEurPerKwh: number; // precio de compensación de excedentes (€/kWh)
  capexEur: number; // kwp × costPerKwp
}

export interface SolarMonthBucket {
  key: string; // "YYYY-MM"
  monthStart: string; // ISO UTC de la primera hora del mes (para ordenar la evolución)
  productionKwh: number;
  selfConsumptionKwh: number;
  surplusKwh: number;
}

export interface SolarResult {
  months: SolarMonthBucket[]; // ordenados por monthStart (evolución temporal)
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number; // autoconsumo / producción
  coverageRatio: number; // autoconsumo / consumo
  annualSavingEur: number;
  paybackYears: number | null; // capex / ahorro; null si ahorro ≤ 0
}
