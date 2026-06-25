// Capa financiera mínima compartida por los optimizadores de M06 v2 (§8.10/§8.11). Puro, sin I/O.

export interface FinancialParams {
  horizonYears?: number; // def 25
  discountRatePct?: number; // def 4
  degradationPctPerYear?: number; // def 0.5
  priceEscalationPctPerYear?: number; // def 0
}

export interface ResolvedFinancial {
  horizonYears: number;
  discountRatePct: number;
  degradationPctPerYear: number;
  priceEscalationPctPerYear: number;
}

export function resolveFinancial(f?: FinancialParams): ResolvedFinancial {
  return {
    horizonYears: f?.horizonYears ?? 25,
    discountRatePct: f?.discountRatePct ?? 4,
    degradationPctPerYear: f?.degradationPctPerYear ?? 0.5,
    priceEscalationPctPerYear: f?.priceEscalationPctPerYear ?? 0,
  };
}

// VAN (§8.10): npv = Σ_{t=1..N} ahorro·(1−deg)^{t−1}·(1+esc)^{t−1} / (1+disc)^t − capex.
// Con deg=esc=disc=0 ⇒ npv = ahorro·N − capex. Sin redondeo intermedio.
export function computeNpv(annualSavingEur: number, capexEur: number, f: ResolvedFinancial): number {
  const deg = f.degradationPctPerYear / 100;
  const esc = f.priceEscalationPctPerYear / 100;
  const disc = f.discountRatePct / 100;
  let npv = -capexEur;
  for (let t = 1; t <= f.horizonYears; t++) {
    const cashflow = annualSavingEur * Math.pow(1 - deg, t - 1) * Math.pow(1 + esc, t - 1);
    npv += cashflow / Math.pow(1 + disc, t);
  }
  return npv;
}
