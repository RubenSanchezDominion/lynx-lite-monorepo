// Variables de entorno deterministas para los tests.
process.env.JWT_SECRET = 'test-secret';
process.env.JWT_EXPIRY = '8h';
process.env.INFLUXDB_BUCKET = 'lynx-lite-test';
