export interface PricingInput {
  tariff: 'T_2_0TD' | 'T_3_0TD';
  periodDays: number;
  modePowerControl: 'ICP' | 'MAXIMETRO';

  contractedPower: Record<string, number>; // kW por período de potencia
  consumption: Record<string, number>;     // kWh totales del período por período de energía
  maxPower: Record<string, number> | null; // kW (ya convertido de W); null si ICP
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
