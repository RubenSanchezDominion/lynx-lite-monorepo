const express = require('express');
const { generateConsumption, generateMaxPower, getSupplyProfile } = require('./generators');
const { checkRateLimit, clearRateLimit } = require('./rateLimit');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MOCK_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.MOCK_TOKEN_FOR_DEVELOPMENT.signature';

// ============================================================
// Middleware: validar Bearer token
// ============================================================
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token>' });
  }
  next();
}

// ============================================================
// 1. LOGIN
// POST /nikola-auth/tokens/login
// Body (urlencoded): username=<NIF>, password=<pass>
// ============================================================
app.post('/nikola-auth/tokens/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('username and password are required');
  }
  console.log(`[LOGIN] usuario=${username}`);
  // Devuelve el token como texto plano, igual que la API real
  res.type('text/plain').send(MOCK_TOKEN);
});

// ============================================================
// 2. GET SUPPLIES
// GET /api-private/api/get-supplies
// Query: authorizedNif (opcional), distributorCode (opcional)
// ============================================================
app.get('/api-private/api/get-supplies', requireAuth, (req, res) => {
  const { authorizedNif } = req.query;
  console.log(`[SUPPLIES] authorizedNif=${authorizedNif || '(propio)'}`);
  res.json([
    {
      address: 'POLIGONO INDUSTRIAL MALPICA, NAVE 47',
      cups: 'ES0031000000000001JN',
      postalCode: '50016',
      province: 'Zaragoza',
      municipality: 'ZARAGOZA',
      distributor: 'EDISTRIBUCION',
      validDateFrom: '2022/01/01',
      validDateTo: '',
      pointType: 3,
      distributorCode: '2'
    },
    {
      address: 'CALLE MAYOR 15, LOCAL',
      cups: 'ES0031000000000002JN',
      postalCode: '50001',
      province: 'Zaragoza',
      municipality: 'ZARAGOZA',
      distributor: 'EDISTRIBUCION',
      validDateFrom: '2021/06/01',
      validDateTo: '',
      pointType: 5,
      distributorCode: '2'
    },
    {
      address: 'AVENIDA GOYA 82, PLANTA BAJA',
      cups: 'ES0031000000000003JN',
      postalCode: '50005',
      province: 'Zaragoza',
      municipality: 'ZARAGOZA',
      distributor: 'I-DE REDES ELECTRICAS INTELIGENTES',
      validDateFrom: '2020/03/15',
      validDateTo: '',
      pointType: 2,
      distributorCode: '8'
    },
    {
      address: 'POLIGONO LA CARTUJA, NAVE 12',
      cups: 'ES0031000000000004JN',
      postalCode: '50018',
      province: 'Zaragoza',
      municipality: 'ZARAGOZA',
      distributor: 'EDISTRIBUCION',
      validDateFrom: '2023/07/01',
      validDateTo: '',
      pointType: 3,
      distributorCode: '2'
    }
  ]);
});

// ============================================================
// 3. GET DISTRIBUTORS WITH SUPPLIES
// GET /api-private/api/get-distributors-with-supplies
// ============================================================
app.get('/api-private/api/get-distributors-with-supplies', requireAuth, (req, res) => {
  console.log(`[DISTRIBUTORS]`);
  res.json({ distributorCodes: ['2', '8'] });
});

// ============================================================
// 4. GET CONTRACT DETAIL
// GET /api-private/api/get-contract-detail
// Query: cups, distributorCode, authorizedNif (opcional)
// ============================================================
app.get('/api-private/api/get-contract-detail', requireAuth, (req, res) => {
  const { cups, distributorCode } = req.query;
  if (!cups || !distributorCode) {
    return res.status(400).json({ error: 'cups y distributorCode son obligatorios' });
  }

  const p = getSupplyProfile(cups);
  console.log(`[CONTRACT] cups=${cups} tariff=${p.tariff}`);

  const isSelfConsumption = p.selfConsumption === true;

  res.json([{
    cups,
    distributor: distributorCode === '8'
      ? 'I-DE REDES ELECTRICAS INTELIGENTES, S.A.U.'
      : 'E-DISTRIBUCION REDES DIGITALES S.L.U.',
    marketer: p.marketer,
    tension: p.tension,
    accessFare: p.tariff,
    province: 'Zaragoza',
    municipality: 'ZARAGOZA',
    postalCode: '50016',
    contractedPowerkW: p.contractedPower,
    timeDiscrimination: '',
    modePowerControl: p.modePowerControl,
    startDate: '2022/01/01',
    endDate: '',
    codeFare: p.codeFare,
    selfConsumptionTypeCode: isSelfConsumption ? '41' : '00',
    selfConsumptionTypeDesc: isSelfConsumption
      ? 'Con excedentes con compensacion Individual'
      : 'Sin autoconsumo',
    section: distributorCode === '8' ? '2' : '1',
    subsection: null,
    partitionCoefficient: 100.0,
    cau: isSelfConsumption ? `ES0031CAU${cups.slice(-8)}` : '',
    installedCapacity: isSelfConsumption ? p.installedCapacityKW : 0
  }]);
});

// ============================================================
// 5. GET CONSUMPTION DATA
// GET /api-private/api/get-consumption-data
// Query: cups, distributorCode, startDate (YYYY/MM), endDate (YYYY/MM),
//        measurementType (0=horario, 1=cuarto-horario), pointType, authorizedNif
// ============================================================
app.get('/api-private/api/get-consumption-data', requireAuth, (req, res) => {
  const { cups, distributorCode, startDate, endDate, measurementType, pointType, authorizedNif } = req.query;

  if (!cups || !distributorCode || !startDate || !endDate || measurementType === undefined || !pointType) {
    return res.status(400).json({ error: 'Parametros obligatorios: cups, distributorCode, startDate, endDate, measurementType, pointType' });
  }

  // Rate limit: misma consulta no se puede repetir en 24h (igual que DATADIS real)
  const key = `consumption:${cups}:${distributorCode}:${startDate}:${endDate}:${measurementType}:${pointType}:${authorizedNif || ''}`;
  if (!checkRateLimit(key)) {
    console.log(`[RATE LIMIT] ${key}`);
    return res.status(429).json({ error: 'Consulta ya realizada en las ultimas 24 horas' });
  }

  console.log(`[CONSUMPTION] cups=${cups} ${startDate}->${endDate} type=${measurementType === '1' ? 'cuarto-horario' : 'horario'}`);
  const data = generateConsumption(cups, startDate, endDate, measurementType);
  console.log(`  -> ${data.length} registros generados`);
  res.json(data);
});

// ============================================================
// 6. GET MAX POWER
// GET /api-private/api/get-max-power
// Query: cups, distributorCode, startDate (YYYY/MM), endDate (YYYY/MM), authorizedNif
// ============================================================
app.get('/api-private/api/get-max-power', requireAuth, (req, res) => {
  const { cups, distributorCode, startDate, endDate, authorizedNif } = req.query;

  if (!cups || !distributorCode || !startDate || !endDate) {
    return res.status(400).json({ error: 'Parametros obligatorios: cups, distributorCode, startDate, endDate' });
  }

  const key = `maxpower:${cups}:${distributorCode}:${startDate}:${endDate}:${authorizedNif || ''}`;
  if (!checkRateLimit(key)) {
    console.log(`[RATE LIMIT] ${key}`);
    return res.status(429).json({ error: 'Consulta ya realizada en las ultimas 24 horas' });
  }

  console.log(`[MAX POWER] cups=${cups} ${startDate}->${endDate}`);
  const data = generateMaxPower(cups, startDate, endDate);
  console.log(`  -> ${data.length} registros generados`);
  res.json(data);
});

// ============================================================
// UTILIDADES SOLO PARA DESARROLLO
// ============================================================

// Resetear rate limits sin reiniciar el servidor
app.post('/dev/reset-rate-limit', (req, res) => {
  clearRateLimit();
  console.log('[DEV] Rate limits reseteados');
  res.json({ ok: true, message: 'Rate limits reseteados' });
});

// Estado del servidor
app.get('/dev/status', (req, res) => {
  res.json({
    status: 'ok',
    cups_disponibles: [
      { cups: 'ES0031000000000001JN', perfil: 'Industrial 3.0TD maximetro 50kW' },
      { cups: 'ES0031000000000002JN', perfil: 'Pyme 2.0TD ICP 9.2kW' },
      { cups: 'ES0031000000000003JN', perfil: 'Industrial 6.1TD maximetro 120-200kW' },
      { cups: 'ES0031000000000004JN', perfil: 'Industrial 3.0TD con autoconsumo solar 80kWp' }
    ]
  });
});

// ============================================================
// ARRANQUE
// ============================================================
app.listen(PORT, () => {
  console.log(`\n===================================================`);
  console.log(`  DATADIS Mock Server — http://localhost:${PORT}`);
  console.log(`===================================================`);
  console.log(`\nEndpoints disponibles:`);
  console.log(`  POST /nikola-auth/tokens/login`);
  console.log(`  GET  /api-private/api/get-supplies`);
  console.log(`  GET  /api-private/api/get-distributors-with-supplies`);
  console.log(`  GET  /api-private/api/get-contract-detail`);
  console.log(`  GET  /api-private/api/get-consumption-data`);
  console.log(`  GET  /api-private/api/get-max-power`);
  console.log(`\nCUPS de prueba:`);
  console.log(`  ES0031000000000001JN  Industrial 3.0TD maximetro 50kW`);
  console.log(`  ES0031000000000002JN  Pyme 2.0TD ICP 9.2kW`);
  console.log(`  ES0031000000000003JN  Industrial 6.1TD maximetro 120-200kW`);
  console.log(`  ES0031000000000004JN  Industrial 3.0TD con autoconsumo solar 80kWp`);
  console.log(`\nUtilidades:`);
  console.log(`  GET  /dev/status`);
  console.log(`  POST /dev/reset-rate-limit`);
  console.log(`\nUso en LYNX Lite: DATADIS_URL=http://localhost:${PORT}\n`);
});
