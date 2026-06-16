// ─── Adaptador PVGIS (re.jrc.ec.europa.eu, /api/v5_2/PVcalc) ────────────────────
// PVcalc devuelve producción MENSUAL/ANUAL (no serie horaria): el reparto a horas lo hace el servicio.

export interface PvgisMonth {
  month: number; // 1..12
  E_m: number; // kWh/mes
}

export interface PvgisResponse {
  outputs: {
    monthly: { fixed: PvgisMonth[] };
    totals: { fixed: { E_y: number } };
  };
}

// Producción normalizada: 12 valores mensuales (kWh) + total anual (kWh).
export interface PvProduction {
  monthly: number[]; // longitud 12, índice 0 = enero
  annual: number;
}

export interface PvProductionParams {
  lat: number;
  lon: number;
  kwp: number; // potencia pico → peakpower
  lossPct: number; // pérdidas del sistema → loss
  tilt: number; // inclinación → angle
  azimuth: number; // orientación → aspect
}

export interface PvgisHttp {
  get(path: string, query: Record<string, string>): Promise<unknown>;
}

// Transforma la respuesta de PVcalc en { monthly[12], annual }.
export function parsePvProduction(raw: PvgisResponse): PvProduction {
  const fixed = raw?.outputs?.monthly?.fixed ?? [];
  const monthly = new Array<number>(12).fill(0);
  for (const m of fixed) {
    if (m.month >= 1 && m.month <= 12) monthly[m.month - 1] = m.E_m;
  }
  const annual = raw?.outputs?.totals?.fixed?.E_y ?? monthly.reduce((a, b) => a + b, 0);
  return { monthly, annual };
}

// Pide la estimación de producción a PVGIS y la normaliza. Lanza si PVGIS no responde (200).
export async function fetchPvProduction(http: PvgisHttp, params: PvProductionParams): Promise<PvProduction> {
  const raw = (await http.get('/api/v5_2/PVcalc', {
    lat: String(params.lat),
    lon: String(params.lon),
    peakpower: String(params.kwp),
    loss: String(params.lossPct),
    angle: String(params.tilt),
    aspect: String(params.azimuth),
    outputformat: 'json',
  })) as PvgisResponse;
  return parsePvProduction(raw);
}
