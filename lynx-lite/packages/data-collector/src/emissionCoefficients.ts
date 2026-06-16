// Coeficientes de emisión de CO₂ por tecnología de generación (gCO₂/kWh), indexados por el
// título que devuelve REData en `estructura-generacion` (SPECS §7.0).
//
// ⚠️ VALORES DE PARTIDA — NO CALIBRADOS. Son factores operacionales (de combustión) de orden de
// magnitud estándar (IPCC / REE / MITECO). NO usar para reporting CSRD defendible hasta sustituirlos
// por la publicación oficial vigente. Centralizados aquí para cambiarlos en un único sitio.
//
// TODO(calibrar): reemplazar por los factores oficiales (MITECO/REE) y citar la fuente/fecha.
export const EMISSION_COEFFICIENTS: Record<string, number> = {
  Nuclear: 0,
  Hidráulica: 0,
  Eólica: 0,
  'Solar fotovoltaica': 0,
  'Solar térmica': 0,
  'Turbinación bombeo': 0,
  'Ciclo combinado': 370,
  Carbón: 950,
  Cogeneración: 400,
  Residuos: 700,
};
