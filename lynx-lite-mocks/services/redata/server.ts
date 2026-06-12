import { Hono } from 'hono';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3002);

function toISO8601(date: Date, offsetHours = 1): string {
  const sign = offsetHours >= 0 ? '+' : '-';
  const offsetStr = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  const shifted = new Date(date.getTime() + offsetHours * 3_600_000);
  return shifted.toISOString().replace('Z', offsetStr);
}

function parseQueryDate(s: string): Date {
  const normalized = s.length === 16 ? s + ':00Z' : s.endsWith('Z') ? s : s + 'Z';
  return new Date(normalized);
}

function stepMinutes(trunc: string): number {
  if (trunc === 'hour') return 60;
  if (trunc === 'day')  return 1440;
  return 10; // ten-minutes (default)
}

function demandMW(hour: number): number {
  let factor: number;
  if      (hour >= 9  && hour < 14) factor = 1.00;
  else if (hour >= 15 && hour < 21) factor = 0.90;
  else if (hour >= 7  && hour < 9)  factor = 0.60;
  else                               factor = 0.10;
  const noise = 0.97 + Math.random() * 0.06;
  return Math.round((22_000 + 16_000 * factor) * noise);
}

function buildValues(startDate: Date, endDate: Date, trunc: string) {
  const step = stepMinutes(trunc);
  const cur  = new Date(startDate);
  const out: { value: string; percentage: number | null; datetime: string }[] = [];
  while (cur <= endDate) {
    out.push({ value: String(demandMW(cur.getUTCHours())), percentage: null, datetime: toISO8601(cur) });
    cur.setMinutes(cur.getMinutes() + step);
  }
  return out;
}

const GENERATION_SERIES = [
  { id: '10029', title: 'Nuclear',             color: '#ea4f3d', f: 0.20 },
  { id: '10034', title: 'Ciclo combinado',      color: '#ff6600', f: 0.18 },
  { id: '10030', title: 'Carbón',               color: '#6c4b24', f: 0.03 },
  { id: '10033', title: 'Hidráulica',           color: '#0070c0', f: 0.12 },
  { id: '10037', title: 'Eólica',               color: '#00b050', f: 0.22 },
  { id: '10041', title: 'Solar fotovoltaica',   color: '#ffcc00', f: 0.10 },
  { id: '10042', title: 'Solar térmica',        color: '#ffa500', f: 0.04 },
  { id: '10044', title: 'Cogeneración',         color: '#7030a0', f: 0.06 },
  { id: '10228', title: 'Residuos',             color: '#808080', f: 0.02 },
  { id: '10036', title: 'Turbinación bombeo',   color: '#00bcd4', f: 0.03 },
];

function validateParams(c: Parameters<Parameters<typeof app.get>[1]>[0]) {
  const { start_date, end_date, time_trunc } = c.req.query();
  if (!start_date || !end_date || !time_trunc) {
    return c.json({ errors: [{ title: 'Required query params: start_date, end_date, time_trunc' }] }, 400);
  }
  return null;
}

app.get('/es/datos/demanda/demanda-tiempo-real', c => {
  const err = validateParams(c);
  if (err) return err;

  const { start_date, end_date, time_trunc } = c.req.query();
  const values   = buildValues(parseQueryDate(start_date), parseQueryDate(end_date), time_trunc);
  const lastUpdate = toISO8601(new Date());

  return c.json({
    data: { type: 'Demandas', id: '10034', attributes: { title: 'Demanda en tiempo real', 'last-update': lastUpdate, description: null } },
    included: [{
      type: 'Demanda', id: '1293', groupId: '1',
      attributes: {
        title: 'Demanda real', 'last-update': lastUpdate,
        color: '#00a1d1', type: 'line', magnitude: 'MW', composite: false,
        'last-value': values.at(-1)?.value ?? '0',
        values,
      },
    }],
  });
});

app.get('/es/datos/generacion/estructura-generacion', c => {
  const err = validateParams(c);
  if (err) return err;

  const { start_date, end_date, time_trunc } = c.req.query();
  const demandVals = buildValues(parseQueryDate(start_date), parseQueryDate(end_date), time_trunc);
  const lastUpdate  = toISO8601(new Date());

  const included = GENERATION_SERIES.map(s => {
    const values = demandVals.map(dv => ({
      value: String(Math.round(Number(dv.value) * s.f * (0.90 + Math.random() * 0.20))),
      percentage: Math.round(s.f * 100),
      datetime: dv.datetime,
    }));
    return {
      type: 'Generacion', id: s.id, groupId: '2',
      attributes: {
        title: s.title, 'last-update': lastUpdate,
        color: s.color, type: 'bar', magnitude: 'MW', composite: false,
        'last-value': values.at(-1)?.value ?? '0',
        values,
      },
    };
  });

  return c.json({
    data: { type: 'Generacion', id: '10035', attributes: { title: 'Estructura de generación', 'last-update': lastUpdate, description: null } },
    included,
  });
});

console.log('GET /es/datos/demanda/demanda-tiempo-real');
console.log('GET /es/datos/generacion/estructura-generacion');

export default { port: PORT, fetch: app.fetch };
