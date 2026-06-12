import { Hono } from 'hono';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3004);

// Seasonal distribution factors (jan..dec), sum ≈ 11.25
const MONTHLY_FACTORS = [0.55, 0.65, 0.85, 1.10, 1.30, 1.45, 1.45, 1.35, 1.10, 0.85, 0.65, 0.50];
const FACTOR_SUM = MONTHLY_FACTORS.reduce((a, b) => a + b, 0);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const PV_TECH_MAP: Record<string, string> = { crystSi: 'c-Si', CIS: 'CIS', CdTe: 'CdTe', Unknown: 'Unknown' };

function calcPvgis(lat: number, lon: number, peakpower: number, loss: number, angle: number, aspect: number, pvtech: string, mounting: string) {
  const irr_y  = Math.max(900, 1800 - (lat - 36) * 50);
  const E_y    = Number((peakpower * irr_y * (1 - loss / 100) * 0.82).toFixed(1));
  const E_d    = Number((E_y / 365).toFixed(2));
  const E_m    = Number((E_y / 12).toFixed(1));
  const Hi_y   = Number(irr_y.toFixed(1));
  const elev   = Math.max(0, Math.round((lat - 37) * 200 + 300));

  const monthly = MONTHLY_FACTORS.map((f, i) => {
    const Em  = Number((E_y  * f / FACTOR_SUM).toFixed(1));
    const Him = Number((Hi_y * f / FACTOR_SUM).toFixed(1));
    return {
      month:      i + 1,
      E_d:        Number((Em  / DAYS[i]).toFixed(2)),
      E_m:        Em,
      'H(i)_d':  Number((Him / DAYS[i]).toFixed(2)),
      'H(i)_m':  Him,
      SD_m:       Number((Em * 0.05).toFixed(1)),
    };
  });

  const totals = {
    E_d, E_m, E_y,
    'H(i)_d': Number((Hi_y / 365).toFixed(2)),
    'H(i)_m': Number((Hi_y / 12).toFixed(1)),
    'H(i)_y': Hi_y,
    SD_y:      Number((E_y * 0.05).toFixed(1)),
    l_aoi:     2.8,
    l_spec:    '1.89',
    l_tg:      Number((loss * 0.6).toFixed(2)),
    l_total:   Number(loss.toFixed(2)),
  };

  return {
    inputs: {
      location: { latitude: lat, longitude: lon, elevation: elev },
      meteo_data: { radiation_db: 'PVGIS-SARAH2', year_min: 2005, year_max: 2020, use_horizon: true, horizon_db: 'DEM-calculated' },
      mounting_system: {
        fixed: {
          slope:   { value: angle,  optimal: angle  === 35 ? 'YES' : 'NO' },
          azimuth: { value: aspect, optimal: aspect === 0  ? 'YES' : 'NO' },
          type:    mounting === 'building' ? 'building-integrated' : 'free-standing',
        },
      },
      pv_module: { technology: PV_TECH_MAP[pvtech] ?? 'c-Si', peak_power: peakpower, system_loss: loss },
    },
    outputs: {
      fixed:   { type: 'time', timestamp: new Date().toISOString(), ...totals },
      monthly: { fixed: monthly },
      totals:  { fixed: totals },
    },
    meta: {
      inputs: {
        description: 'Estimated power generation from PV system',
        variables: {
          E_d: { description: 'Average daily energy production',   units: 'kWh/day'   },
          E_m: { description: 'Average monthly energy production', units: 'kWh/month' },
          E_y: { description: 'Average annual energy production',  units: 'kWh/year'  },
        },
      },
      outputs: {
        daily_energy:   { description: 'Average daily energy production',   units: 'kWh/day'   },
        monthly_energy: { description: 'Average monthly energy production', units: 'kWh/month' },
        yearly_energy:  { description: 'Average annual energy production',  units: 'kWh/year'  },
      },
    },
  };
}

app.get('/api/v5_2/PVcalc', c => {
  const { lat, lon, peakpower } = c.req.query();
  if (!lat || !lon || !peakpower) {
    return c.json({ status: 'error', message: 'Required parameters missing: lat, lon, peakpower' }, 400);
  }

  return c.json(calcPvgis(
    Number(lat),
    Number(lon),
    Number(peakpower),
    Number(c.req.query('loss')         ?? 14),
    Number(c.req.query('angle')        ?? 35),
    Number(c.req.query('aspect')       ?? 0),
    c.req.query('pvtechchoice')        ?? 'crystSi',
    c.req.query('mountingplace')       ?? 'free',
  ));
});

console.log('GET /api/v5_2/PVcalc');

export default { port: PORT, fetch: app.fetch };
