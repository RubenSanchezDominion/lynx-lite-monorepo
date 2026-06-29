// Demo CNMC — proxy + página única. Node 18+ (fetch global), sin dependencias.
// Arranque:  node server.mjs   →   http://localhost:8080
//
// Por qué un proxy: la API pública de la CNMC responde 403 si la petición lleva
// cabecera Origin (navegador) y no expone Access-Control-Allow-*. Desde el
// servidor (sin Origin) responde 200. Este server llama a la CNMC server-side,
// normaliza las ofertas y las cruza con el coste actual que indica el cliente.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 8080;
const CNMC = 'https://comparador.cnmc.gob.es/api/publico/ofertas/electricidad';

// ─── Parámetros que el backend de la CNMC exige presentes aunque vayan a 0 ──────
// (recortarlos provoca 500 Internal Server Error — verificado)
const ZEROS = [
  'consumoCuartaFranja', 'consumoQuintaFranja', 'consumoSextaFranja',
  'consumoAnualEQr', 'consumoPrimeraFranjaQr', 'consumoSegundaFranjaQr', 'consumoTerceraFranjaQr',
  'consumoCuartaFranjaQr', 'consumoQuintaFranjaQr', 'consumoSextaFranjaQr',
  'consumoAnualEPQr', 'consumoPrimeraFranjaPQr', 'consumoSegundaFranjaPQr', 'consumoTerceraFranjaPQr',
  'consumoCuartaFranjaPQr', 'consumoQuintaFranjaPQr', 'consumoSextaFranjaPQr',
  'energiaAutoconsumo', 'idAuditoriaQR', 'importe', 'tc', 'bs', 'impSA', 'impOtros', 'exc', 'reg',
  'mecanismoAjuste', 'importeMecanismoAjustePunta', 'importeMecanismoAjusteLlano', 'importeMecanismoAjusteValle',
  'precioConsumoMecanismoAjustePunta', 'precioConsumoMecanismoAjusteLlano', 'precioConsumoMecanismoAjusteValle',
  'precioConsumoMecanismoAjusteTotal', 'mecanismoAjusteIVA', 'impOtrosConIE', 'impOtrosSinIE',
  'pmaxP1', 'pmaxP2', 'dtoBS', 'finBS', 'ajuste', 'impPot', 'impEner', 'dto',
  'prP1', 'prP2', 'prE1', 'prE2', 'prE3', 'cfP1flex', 'cfP2flex', 'cambio', 'promo', 'verde', 'rev', 'trampeo',
];

// Construye el query string completo de la CNMC a partir de los datos del cliente.
function buildCnmcParams(c) {
  const p = String(c.potencia);
  const c1 = Number(c.c1) || 0, c2 = Number(c.c2) || 0, c3 = Number(c.c3) || 0;
  const periodo = c1 + c2 + c3; // consumo del periodo facturado (suma de franjas)

  const params = {
    tipoSuministro: 'E',
    codigoPostal: String(c.cp),
    potencia: p, potenciaPrimeraFranja: p, potenciaSegundaFranja: p, potenciaTerceraFranja: p,
    potenciaCuartaFranja: p, potenciaQuintaFranja: p, potenciaSextaFranja: p, potenciaAutoconsumo: p,
    consumoAnualE: String(periodo),
    consumoAnualEOrig: String(Number(c.consumoAnual) || periodo * 12),
    consumoPrimeraFranja: String(c1),
    consumoSegundaFranja: String(c2),
    consumoTerceraFranja: String(c3),
    tarifa: String(c.tarifa ?? 4), // 4 = 2.0TD
    consumoAnualG: String(Number(c.gas) || 0),
    consumoAnualGOrig: String(Number(c.gas) || 0),
    serviciosAdicionales: '2',
    permanencia: '2',
    vivienda: 'true', factura: 'true', revisionPrecios: '2',
    dateInicio: String(c.dateInicio),
    dateFin: String(c.dateFin),
    fFact: String(c.dateFin),
    perfilConsumo: '13', cups: '0000', autoconsumo: 'false',
  };
  for (const k of ZEROS) params[k] = '0';
  return new URLSearchParams(params).toString();
}

// Normaliza una oferta cruda de la CNMC a la forma que usa la página.
function normalize(o) {
  return {
    comercializadora: o.comercializadora,
    oferta: o.oferta,
    importePrimerAnio: o.importePrimerAnio,
    importeSegundoAnio: o.importeSegundoAnio,
    penalizacion: !!o.penalizacion,
    importeEstimadoPenalizacion: o.importeEstimadoPenalizacion ?? 0,
    verde: !!o.verde,
    peaje: o.peaje,
  };
}

async function handleOffers(reqUrl, res) {
  const q = Object.fromEntries(reqUrl.searchParams);

  // Periodo de facturación por defecto: ~31 días terminando hoy (epoch ms).
  const dateFin = Number(q.dateFin) || Date.now();
  const dateInicio = Number(q.dateInicio) || dateFin - 31 * 86_400_000;

  const cliente = {
    cp: q.cp || '1400',
    potencia: q.potencia || '3.5',
    c1: q.c1 || '0', c2: q.c2 || '0', c3: q.c3 || '0',
    consumoAnual: q.consumoAnual,
    tarifa: q.tarifa || '4',
    gas: q.gas || '0',
    dateInicio, dateFin,
  };

  const url = `${CNMC}?${buildCnmcParams(cliente)}&`;
  const upstream = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    // sin cabecera Origin: la CNMC responde 200 server-side
  });
  if (!upstream.ok) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `CNMC respondió ${upstream.status}`, url }));
    return;
  }
  const raw = await upstream.json();

  // Ranking por importe del primer año (asc). Excluimos las que penalizan por
  // permanencia si el cliente lo pidió; aquí las marcamos pero no las quitamos.
  const ofertas = (raw.resultadoComparador ?? [])
    .map(normalize)
    .sort((a, b) => a.importePrimerAnio - b.importePrimerAnio);

  // Comparación contra el coste actual del cliente (mismo periodo/base que la CNMC).
  const costeActual = Number(q.costeActual);
  const mejor = ofertas[0];
  const comparacion = (Number.isFinite(costeActual) && costeActual > 0 && mejor)
    ? {
        costeActual,
        mejorOferta: mejor.importePrimerAnio,
        ahorro: +(costeActual - mejor.importePrimerAnio).toFixed(2),
        ahorroPct: +(((costeActual - mejor.importePrimerAnio) / costeActual) * 100).toFixed(1),
      }
    : null;

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    total: ofertas.length,
    periodo: { dateInicio, dateFin },
    comparacion,
    ofertas,
  }));
}

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname === '/api/offers') {
      await handleOffers(reqUrl, res);
      return;
    }
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404).end('Not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Demo CNMC en  http://localhost:${PORT}`);
});
