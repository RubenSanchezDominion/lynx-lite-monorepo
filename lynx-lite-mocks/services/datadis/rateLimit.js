// Simula el rate limit de 24h de la API real de DATADIS
// Una misma combinacion de parametros no puede repetirse antes de 24h
// Referencia: seccion 4.3 y 4.4 del manual oficial DATADIS

const calls = new Map();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 horas en milisegundos

/**
 * Comprueba si una clave puede ejecutarse.
 * Devuelve true si se permite (y registra la llamada).
 * Devuelve false si la clave ya fue usada en las ultimas 24h.
 */
function checkRateLimit(key) {
  const now = Date.now();
  const lastCall = calls.get(key);
  if (lastCall && (now - lastCall) < TTL_MS) {
    return false;
  }
  calls.set(key, now);
  return true;
}

/**
 * Limpia todos los rate limits registrados.
 * Util durante el desarrollo para no reiniciar el servidor.
 * Llamar via: POST /dev/reset-rate-limit
 */
function clearRateLimit() {
  calls.clear();
}

/**
 * Devuelve el numero de claves actualmente registradas.
 */
function getRateLimitCount() {
  return calls.size;
}

module.exports = { checkRateLimit, clearRateLimit, getRateLimitCount };
