import type { InverterPreset } from './types.js';

// Presets semilla por marca. Son DATOS, no código: cada uno aporta pistas de cabecera para reconocer la
// marca y defaults de mapeo. Una marca desconocida no rompe nada — simplemente no casa preset y el
// usuario confirma el mapeo a mano. Un mapeo manual que funciona puede guardarse como preset nuevo.
export const SEED_PRESETS: InverterPreset[] = [
  {
    name: 'huawei-fusionsolar',
    label: 'Huawei FusionSolar',
    // Export pivotado (Timestamp | <SN inv1> | … | Sum), yield en kWh, hora local de planta.
    headerHints: ['fusionsolar', 'inverter sn', 'string', 'yield', 'rendimiento'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: ',', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'fronius-solarweb',
    label: 'Fronius Solar.web',
    headerHints: ['solar.web', 'solarweb', 'energy production', 'pv production', 'fronius'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: ',', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'solaredge',
    label: 'SolarEdge Monitoring',
    headerHints: ['solaredge', 'energy.values', 'measuredby', 'site production'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 0.001, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'enphase-enlighten',
    label: 'Enphase Enlighten',
    headerHints: ['enphase', 'enlighten', 'energy produced', 'produced (wh)'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 0.001, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'victron-vrm',
    label: 'Victron VRM',
    headerHints: ['victron', 'vrm', 'pv yield', 'solar yield'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'solis-soliscloud',
    label: 'Solis SolisCloud',
    headerHints: ['solis', 'soliscloud', 'ginlong', 'egen', 'generation(kwh)'],
    defaults: { valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
  },
  {
    name: 'generic-power',
    label: 'Genérico — potencia AC',
    headerHints: ['ac_power', 'ac power', 'pac', 'active power', 'power(kw)'],
    defaults: { valueKind: 'POWER', unitScaleToKwh: 1, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 },
  },
];
