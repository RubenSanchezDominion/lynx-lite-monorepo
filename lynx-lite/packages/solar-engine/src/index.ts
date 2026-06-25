export { simulateSolar } from './engine.js';
export { optimizeSizing } from './sizing.js';
export { optimizeOrientation } from './orientation.js';
export { resolveFinancial, computeNpv } from './finance.js';
export type {
  SolarHour,
  SolarInput,
  SolarMonthBucket,
  SolarResult,
} from './types.js';
export type { FinancialParams, ResolvedFinancial } from './finance.js';
export type {
  SolarSizingInput,
  SolarSizingPoint,
  SolarSizingResult,
} from './sizing.js';
export type {
  OrientationCandidate,
  SolarOrientationInput,
  SolarOrientationPoint,
  SolarOrientationResult,
} from './orientation.js';
