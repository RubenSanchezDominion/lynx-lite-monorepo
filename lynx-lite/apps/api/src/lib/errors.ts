import { GraphQLError } from 'graphql';

// Códigos de error definidos en SPECS §2.6 (auth) y §3.5 (M01).
export type ErrorCode =
  // Auth
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'USER_NOT_FOUND'
  | 'EMAIL_ALREADY_EXISTS'
  | 'SUPPLY_SCOPE_MISMATCH'
  // M01
  | 'SUPPLY_NOT_FOUND'
  | 'BACKFILL_PENDING'
  | 'BACKFILL_RUNNING'
  | 'BACKFILL_FAILED'
  | 'CONTRACT_NOT_FOUND'
  | 'NO_CONSUMPTION_DATA'
  | 'REGULATORY_DATA_MISSING'
  // M02
  | 'INSUFFICIENT_HISTORY'
  | 'OPTIMIZATION_NOT_FOUND'
  // M03
  | 'ALERT_NOT_FOUND'
  | 'ALERT_CONFIG_NOT_FOUND'
  // M04
  | 'KPI_INVALID_ROW'
  | 'KPI_OVERLAPPING_INTERVALS'
  | 'KPI_NO_PRODUCTION_DATA'
  | 'KPI_UPLOAD_NOT_FOUND'
  // M05
  | 'CO2_NO_FACTOR_DATA'
  // M06
  | 'SOLAR_INVALID_PARAMS'
  | 'PVGIS_UNAVAILABLE'
  // M06.3 — ingesta de inversor
  | 'INVERTER_INVALID_MAPPING'
  | 'INVERTER_PARSE_FAILED';

export function gqlError(code: ErrorCode, message?: string): GraphQLError {
  return new GraphQLError(message ?? code, { extensions: { code } });
}

// Atajos para los más usados.
export const unauthenticated = (msg?: string) => gqlError('UNAUTHENTICATED', msg);
export const forbidden = (msg?: string) => gqlError('FORBIDDEN', msg);
