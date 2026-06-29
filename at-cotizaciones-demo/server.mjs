// PoC — Comparador de cotizaciones de electricidad en ALTA TENSIÓN (6.xTD).
// Node 18+ (fetch global), sin dependencias.   node server.mjs  → http://localhost:8090
//
// Idea: en AT no hay "ofertas publicadas" que scrapear; hay COTIZACIONES que el
// cliente recibe (fijo / indexado / híbrido / PPA). Este PoC coge precios spot
// REALES de REData (apidatos.ree.es, ya en el stack de lynx-lite), los cruza con
// la curva horaria del cliente y calcula, para cada cotización, el coste anual
// esperado + su banda de riesgo bajo varios escenarios de mercado.
//
// Lo que es real: el precio spot horario (REData). Lo que es supuesto y va
// claramente marcado como ORIENTATIVO: los peajes/cargos 6.1TD y la curva forward
// (vendría de OMIP). Es un PoC para validar el ENFOQUE, no cifras de producción.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 8090;
const REDATA = 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real';

// ─── Curva de carga horaria de una industria a 2 turnos (pesos relativos 0..1) ──
// Sube en horario laboral (6-22h), valle de madrugada. Se normaliza al consumo
// anual que indique el usuario. En producción saldría de Datadis (curva real).
const LOAD_SHAPE = [
  .45, .42, .40, .40, .42, .55, .80, .95, 1.0, 1.0, .98, .95,
  .85, .88, .95, .98, .97, .90, .80, .70, .62, .58, .52, .48,
];

// ─── Escenarios de mercado: nivel baseload (€/MWh) y probabilidad ───────────────
// El NIVEL escala el perfil real de spot; la FORMA horaria se conserva de REData.
// Centrados alrededor de la curva forward (OMIP) que pase el usuario.
function buildScenarios(forward) {
  return [
    { name: 'Bajo',    level: forward * 0.70, prob: 0.20 },
    { name: 'Central', level: forward * 1.00, prob: 0.40 },
    { name: 'Alto',    level: forward * 1.45, prob: 0.30 },
    { name: 'Estrés',  level: forward * 2.20, prob: 0.10 },
  ];
}

const ymd = (date) => date.toISOString().slice(0, 10);

// Trae ~21 días de spot real y devuelve el perfil medio por hora del día (24 val).
async function fetchSpotShape() {
  const end = new Date();
  const start = new Date(end.getTime() - 21 * 86_400_000);
  const url = `${REDATA}?start_date=${ymd(start)}T00:00&end_date=${ymd(end)}T23:59&time_trunc=hour`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`REData → ${res.status}`);
  const data = await res.json();
  const spot = (data.included ?? []).find(s => /spot/i.test(s.type));
  const values = spot?.attributes?.values ?? [];
  if (!values.length) throw new Error('REData no devolvió serie spot');

  // Media por hora-del-día (buckets 0..23). REData ya viene cuarto-horario o horario.
  const sum = Array(24).fill(0), cnt = Array(24).fill(0);
  for (const v of values) {
    const h = new Date(v.datetime).getHours();
    sum[h] += v.value; cnt[h]++;
  }
  const shape = sum.map((s, h) => (cnt[h] ? s / cnt[h] : 0));
  const all = values.map(v => v.value);
  return {
    shape,                                         // €/MWh medio por hora del día
    meanReal: all.reduce((a, b) => a + b, 0) / all.length,
    days: 21,
  };
}

// Precio de energía CAPTURADO (€/MWh) = media del spot ponderada por la carga.
// Captura la correlación "consumo cuando el precio es alto" — el meollo del riesgo.
function capturedPrice(spotShape, level) {
  const baseMean = spotShape.reduce((a, b) => a + b, 0) / 24;
  const k = baseMean ? level / baseMean : 1; // escala el nivel manteniendo la forma
  let num = 0, den = 0;
  for (let h = 0; h < 24; h++) { num += LOAD_SHAPE[h] * spotShape[h] * k; den += LOAD_SHAPE[h]; }
  return num / den;
}

// €/MWh de energía de UNA cotización en UN escenario (la parte que compite).
function energyUnit(q, captured) {
  switch (q.tipo) {
    case 'fijo':     return q.precioFijo;
    case 'indexado': return captured + q.margen;
    case 'hibrido':  return q.cobertura * q.precioFijo + (1 - q.cobertura) * (captured + q.margen);
    case 'ppa':      return q.ppaShare * q.ppaPrecio + (1 - q.ppaShare) * (captured + q.margen);
    default:         return captured;
  }
}

function computeQuote(q, ctx) {
  const { spotShape, scenarios, mwhAnual, reguladoEurMwh, potTermAnual } = ctx;
  const perEscenario = scenarios.map(s => {
    const captured = capturedPrice(spotShape, s.level);
    const eUnit = energyUnit(q, captured);
    const energia = eUnit * mwhAnual;
    const regulado = reguladoEurMwh * mwhAnual + potTermAnual; // igual para todas
    return { escenario: s.name, prob: s.prob, capturado: +captured.toFixed(2),
             energiaEurMwh: +eUnit.toFixed(2), total: +(energia + regulado).toFixed(0) };
  });
  const esperado = perEscenario.reduce((a, e) => a + e.prob * e.total, 0);
  const totals = perEscenario.map(e => e.total);
  return {
    nombre: q.nombre, tipo: q.tipo,
    esperado: Math.round(esperado),
    min: Math.min(...totals), max: Math.max(...totals),
    banda: Math.round(Math.max(...totals) - Math.min(...totals)),
    perEscenario,
  };
}

// Cotizaciones por defecto (editables desde la página).
function defaultQuotes() {
  return [
    { nombre: 'Comercializadora A — Fijo',      tipo: 'fijo',     precioFijo: 82 },
    { nombre: 'Comercializadora B — Indexado',  tipo: 'indexado', margen: 11 },
    { nombre: 'Comercializadora C — Híbrido',   tipo: 'hibrido',  precioFijo: 80, margen: 10, cobertura: 0.6 },
    { nombre: 'PPA renovable + resto indexado', tipo: 'ppa',      ppaPrecio: 52, ppaShare: 0.55, margen: 11 },
  ];
}

async function handleCompare(reqUrl, res) {
  const q = Object.fromEntries(reqUrl.searchParams);
  const mwhAnual = Number(q.mwhAnual) || 4000;       // 4 GWh/año
  const potKw = Number(q.potKw) || 1000;             // potencia media contratada
  const forward = Number(q.forward) || 65;           // baseload OMIP (orientativo)
  const reguladoEurMwh = Number(q.reguladoEurMwh) || 22; // peajes+cargos energía 6.1TD (orientativo)
  const potEurKwAnual = Number(q.potEurKwAnual) || 26;   // término potencia €/kW·año (orientativo)

  let quotes = defaultQuotes();
  if (q.quotes) { try { quotes = JSON.parse(q.quotes); } catch { /* usa defaults */ } }

  const spot = await fetchSpotShape();
  const ctx = {
    spotShape: spot.shape,
    scenarios: buildScenarios(forward),
    mwhAnual,
    reguladoEurMwh,
    potTermAnual: potEurKwAnual * potKw,
  };

  const resultados = quotes.map(x => computeQuote(x, ctx)).sort((a, b) => a.esperado - b.esperado);

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    mercado: {
      fuente: 'REData (apidatos.ree.es) — precio mercado spot, últimos ' + spot.days + ' días',
      spotMedioReal: +spot.meanReal.toFixed(2),
      capturadoCentral: +capturedPrice(spot.shape, forward).toFixed(2),
    },
    supuestos: { mwhAnual, potKw, forward, reguladoEurMwh, potEurKwAnual,
                 nota: 'Peajes/cargos 6.1TD y forward son ORIENTATIVOS (irían de CNMC/BOE y OMIP).' },
    escenarios: buildScenarios(forward),
    resultados,
  }, null, 1));
}

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname === '/api/compare') return void await handleCompare(reqUrl, res);
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(html);
    }
    res.writeHead(404).end('Not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

server.listen(PORT, () => console.log(`PoC cotizaciones AT en  http://localhost:${PORT}`));
