import { Hono } from 'hono';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3003);

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

function pvpcEuroMWh(hour: number): number {
  let base = 80;
  let extra = 0;
  if      (hour >= 10 && hour <= 14) extra = 40 + Math.random() * 80;
  else if (hour >= 18 && hour <= 22) extra = 40 + Math.random() * 80;
  else if (hour >= 0  && hour <  8)  base  = Math.max(20, 80 - 30 - Math.random() * 20);
  return Math.max(20, Number(((base + extra) * (0.85 + Math.random() * 0.30)).toFixed(2)));
}

function generatePvpcValues(startDate: Date, endDate: Date) {
  const cur = new Date(startDate);
  cur.setUTCMinutes(0, 0, 0);
  const values: object[] = [];
  while (cur <= endDate) {
    values.push({
      value:        pvpcEuroMWh(cur.getUTCHours()),
      datetime:     toISO8601(cur),
      datetime_utc: cur.toISOString(),
      tz_time:      `${String(cur.getUTCHours()).padStart(2, '0')}:00`,
      geo_id:       3,
      geo_name:     'España',
    });
    cur.setUTCHours(cur.getUTCHours() + 1);
  }
  return values;
}

app.use('*', async (c, next) => {
  if (!c.req.header('x-api-key')) {
    return c.json({ errors: [{ title: 'Unauthorized — missing x-api-key header' }] }, 401);
  }
  return next();
});

app.get('/indicators/1001', c => {
  const now = new Date();
  const todayPrefix = now.toISOString().slice(0, 10);
  const startDate = parseQueryDate(c.req.query('start_date') ?? `${todayPrefix}T00:00`);
  const endDate   = parseQueryDate(c.req.query('end_date')   ?? `${todayPrefix}T23:59`);
  const timeTrunc = c.req.query('time_trunc') ?? 'hour';

  return c.json({
    indicator: {
      short_name:   'PVPC 2.0TD',
      name:         'Precio Voluntario para el Pequeño Consumidor (PVPC) 2.0TD',
      time_trunc:   timeTrunc,
      geo_trunc:    'electric_system',
      magnitude:    { id: 2, name: '€/MWh' },
      disaggregated: false,
      geo_ids:      [3],
      geo_names:    ['España'],
      values:       generatePvpcValues(startDate, endDate),
    },
  });
});

console.log('GET /indicators/1001  (requiere x-api-key)');

export default { port: PORT, fetch: app.fetch };
