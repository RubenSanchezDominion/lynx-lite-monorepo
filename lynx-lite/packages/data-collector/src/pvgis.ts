// ─── Adaptador PVGIS (re.jrc.ec.europa.eu) ──────────────────────────────────────
// `seriescalc` (M06 v2) devuelve serie horaria de un año tipo: la forma intradía depende de
// tilt/azimut (prerrequisito de §8.11) y el servicio solo la alinea a la curva del cliente.
// `PVcalc` (M06 v1, @deprecated más abajo) devolvía agregado mensual y se repartía con una campana.

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

// ─── seriescalc (M06 v2): serie horaria de año tipo ─────────────────────────────

// Una hora del año tipo: posición de calendario UTC + producción (kWh) a la potencia pedida.
export interface PvHourly {
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23 (UTC)
  kwh: number;
}

export interface PvProductionSeries {
  hourly: PvHourly[]; // ~8760 horas del año tipo
  annual: number; // Σ kwh
}

interface PvgisSeriesRow {
  time: string; // "YYYYMMDD:HHmm" (UTC)
  P?: number; // potencia media de la hora (W)
}
export interface PvgisSeriesResponse {
  outputs: { hourly: PvgisSeriesRow[] };
}

// Transforma la respuesta de seriescalc en { hourly[], annual }. `P` (W, media horaria) → kWh.
export function parsePvProductionSeries(raw: PvgisSeriesResponse): PvProductionSeries {
  const rows = raw?.outputs?.hourly ?? [];
  const hourly: PvHourly[] = [];
  let annual = 0;
  for (const r of rows) {
    const t = r.time ?? '';
    const month = Number(t.slice(4, 6));
    const day = Number(t.slice(6, 8));
    const hour = Number(t.slice(9, 11));
    const kwh = (r.P ?? 0) / 1000; // W·h → kWh (cada fila es la media de 1 hora)
    if (month >= 1 && month <= 12) {
      hourly.push({ month, day, hour, kwh });
      annual += kwh;
    }
  }
  return { hourly, annual };
}

// Pide la serie horaria a PVGIS (pvcalc=1) y la normaliza. Lanza si PVGIS no responde (200).
export async function fetchPvProductionSeries(
  http: PvgisHttp,
  params: PvProductionParams,
): Promise<PvProductionSeries> {
  const raw = (await http.get('/api/v5_2/seriescalc', {
    lat: String(params.lat),
    lon: String(params.lon),
    peakpower: String(params.kwp),
    loss: String(params.lossPct),
    angle: String(params.tilt),
    aspect: String(params.azimuth),
    pvcalc: '1',
    outputformat: 'json',
  })) as PvgisSeriesResponse;
  return parsePvProductionSeries(raw);
}

/** @deprecated M06 v2 usa {@link parsePvProductionSeries}. Conservado por compatibilidad. */
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

/** @deprecated M06 v2 usa {@link fetchPvProductionSeries} (serie horaria). Conservado por compatibilidad. */
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
