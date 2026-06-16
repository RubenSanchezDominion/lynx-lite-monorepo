export {
  consumptionToPoint,
  maxPowerToPoint,
  reactiveToPoint,
  fetchConsumption,
  fetchMaxPower,
  fetchReactive,
  fetchDistributorCode,
  DatadisRateLimitError,
  type ConsumptionRecord,
  type MaxPowerRecord,
  type ReactiveRecord,
  type DatadisHttp,
} from './datadis.js';

export {
  pvpcToPoint,
  fetchPvpcPrices,
  type EsiosValue,
  type EsiosResponse,
  type EsiosHttp,
} from './esios.js';

export {
  parseGenerationMix,
  composeCo2Factor,
  genMixToCo2Point,
  fetchGenerationMix,
  type RedataValue,
  type RedataSeries,
  type RedataResponse,
  type GenerationMixHour,
  type RedataHttp,
} from './redata.js';

export { EMISSION_COEFFICIENTS } from './emissionCoefficients.js';

export {
  parsePvProduction,
  fetchPvProduction,
  type PvgisMonth,
  type PvgisResponse,
  type PvProduction,
  type PvProductionParams,
  type PvgisHttp,
} from './pvgis.js';

export {
  getPeriod,
  periodForUtc,
  parseDatadisLocal,
  madridHourAndDay,
  type Tariff,
} from './periods.js';

export { writePoints, toInfluxPoint, type MeasurementPoint } from './points.js';

export {
  createDatadisHttp,
  createEsiosHttp,
  createRedataHttp,
  createPvgisHttp,
  type DatadisConfig,
  type EsiosConfig,
  type RedataConfig,
  type PvgisConfig,
} from './http.js';

export {
  buildImputationPoints,
  imputeConsumptionGaps,
  makePreviousWeekLookup,
  type ImputeParams,
  type PreviousWeekLookup,
} from './imputation.js';
