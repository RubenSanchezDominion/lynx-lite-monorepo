export { detectMapping } from './mapping.js';
export { applyMapping, applyMappingWithStats, parseNumber } from './normalize.js';
export type { NormalizeStats } from './normalize.js';
export { validate } from './validate.js';
export { comparePerformance, alignExpectedToMeasured } from './performance.js';
export { parseCsv } from './csv.js';
export { SEED_PRESETS } from './presets.js';
export {
  parseTimeToUtcMs,
  wallToUtcMs,
  floorToHourUtc,
  monthKeyLocal,
  dayKeyLocal,
} from './time.js';
export type {
  ValueKind,
  ColumnMapping,
  MappingProposal,
  CanonicalPoint,
  InverterPreset,
  ValidationReport,
  PerformanceInput,
  MonthPerformance,
  PerformanceResult,
} from './types.js';
