import { Hono } from 'hono';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3004);

// Seasonal distribution factors (jan..dec), sum ≈ 11.25
const MONTHLY_FACTORS = [0.55, 0.65, 0.85, 1.10, 1.30, 1.45, 1.45, 1.35, 1.10, 0.85, 0.65, 0.50];
const FACTOR_SUM = MONTHLY_FACTORS.reduce((a, b) => a + b, 0);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Horas de luz aproximadas por mes (ene..dic), latitud media España. Para la serie horaria seriescalc.
const DAYLIGHT = [9.5, 10.5, 12, 13, 14, 14.5, 14.5, 13.5, 12, 11, 9.8, 9.2];

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

// seriescalc (M06 v2): serie horaria de un año tipo. Forma intradía sesgada por azimut (aspect):
// Este (−90) adelanta el pico a la mañana, Oeste (+90) lo retrasa a la tarde, Sur (0) al mediodía.
const pad2 = (n: number) => String(n).padStart(2, '0');
function calcPvgisSeries(lat: number, lon: number, peakpower: number, loss: number, angle: number, aspect: number) {
  const irr_y = Math.max(900, 1800 - (lat - 36) * 50);
  const annual = peakpower * irr_y * (1 - loss / 100) * 0.82;
  const peakShift = aspect / 22.5;
  const hourly: Array<{ time: string; P: number }> = [];
  for (let m = 0; m < 12; m++) {
    const perDay = (annual * MONTHLY_FACTORS[m]) / FACTOR_SUM / DAYS[m];
    const center = 12 + peakShift;
    const half = DAYLIGHT[m] / 2;
    const w = new Array<number>(24).fill(0);
    let wsum = 0;
    for (let h = 0; h < 24; h++) {
      const d = (h + 0.5 - center) / half;
      const ww = Math.abs(d) < 1 ? Math.cos((d * Math.PI) / 2) : 0;
      w[h] = ww;
      wsum += ww;
    }
    for (let day = 1; day <= DAYS[m]; day++) {
      for (let h = 0; h < 24; h++) {
        const kwh = wsum > 0 ? (perDay * w[h]) / wsum : 0;
        hourly.push({ time: `2021${pad2(m + 1)}${pad2(day)}:${pad2(h)}10`, P: Number((kwh * 1000).toFixed(2)) });
      }
    }
  }
  return {
    inputs: { location: { latitude: lat, longitude: lon }, mounting_system: { fixed: { slope: { value: angle }, azimuth: { value: aspect } } } },
    outputs: { hourly },
    meta: { outputs: { hourly: { variables: { P: { description: 'PV system power', units: 'W' } } } } },
  };
}

app.get('/api/v5_2/seriescalc', c => {
  const { lat, lon, peakpower } = c.req.query();
  if (!lat || !lon || !peakpower) {
    return c.json({ status: 'error', message: 'Required parameters missing: lat, lon, peakpower' }, 400);
  }
  return c.json(calcPvgisSeries(
    Number(lat),
    Number(lon),
    Number(peakpower),
    Number(c.req.query('loss')  ?? 14),
    Number(c.req.query('angle') ?? 35),
    Number(c.req.query('aspect') ?? 0),
  ));
});

console.log('GET /api/v5_2/PVcalc');
console.log('GET /api/v5_2/seriescalc');

export default { port: PORT, fetch: app.fetch };
