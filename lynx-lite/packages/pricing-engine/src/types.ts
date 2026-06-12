export interface PricingInput {
  tariff: 'T_2_0TD' | 'T_3_0TD';
  periodDays: number;
  modePowerControl: 'ICP' | 'MAXIMETRO';

  contractedPower: Record<string, number>; // kW por período de potencia
  consumption: Record<string, number>;     // kWh totales del período por período de energía
  maxPower: Record<string, number> | null; // kW (ya convertido de W); null si ICP
  // Término de exceso de potencia tepp4-5 (€/kW·día) por período de potencia.
  // Origen: maestro ExcessPowerRate. {} si ICP (no se usa).
  excessRates: Record<string, number>;
  pvpcPrice: Record<string, number>;       // €/kWh medio ponderado por período

  tollRates: {
    power: Record<string, number>;  // €/kW/día
    energy: Record<string, number>; // €/kWh
  };
  chargeRates: {
    power: Record<string, number>;  // €/kW/día
    energy: Record<string, number>; // €/kWh
  };

  ieeRate: number;           // ej. 0.0511269632
  vatRate: number;           // ej. 0.21
  meterRentalPerDay: number; // €/día

  reactiveEnergy: Record<string, number> | null; // kVArh por período P1–P6; null si 2.0TD o sin datos
  reactiveRates: { tier1Eur: number; tier2Eur: number } | null;

  hasSurplus: boolean;
}

export interface PricingLine {
  concept: string;
  period: number | null;
  quantity: number;
  unit: string;  // 'kW·día' | 'kWh' | 'kW' | 'kVArh' | 'día' | '%'
  unitPrice: number;
  amount: number;
  sortOrder: number;
}

// ─── Término de exceso de potencia (art. 9.4.b.1 Circular 3/2020, tipos 4 y 5) ──
// Función pura reutilizada por M01 (pre-factura) y M02 (optimización de potencia).
export interface ExcessTermInput {
  modePowerControl: 'ICP' | 'MAXIMETRO';
  contractedPower: Record<string, number>;   // Pcp (kW) por período
  maxPower: Record<string, number> | null;    // Pdp (kW) por período; null = sin maxímetro
  excessRates: Record<string, number>;        // tepp4-5 (€/kW·día) por período
  days: number;                                // n — días de facturación del tramo
}

export interface ExcessTermLine {
  period: number;
  excessKw: number;    // Pdp − Pcp (> 0)
  tepPerDay: number;   // tepp4-5 €/kW·día
  days: number;        // n
  amount: number;      // tepp4-5 × (Pdp − Pcp) × n
}

export interface ExcessTermResult {
  total: number;
  lines: ExcessTermLine[];
}

export interface PricingResult {
  powerTerm: number;
  energyTerm: number;
  excessPower: number;
  reactiveEnergy: number;      // 0 si reactiveEnergy input es null
  surplusCompensation: number; // 0 en v1
  meterRental: number;
  ieeBase: number;
  ieeAmount: number;
  subtotal: number;
  vatAmount: number;
  total: number;
  lines: PricingLine[];
}
