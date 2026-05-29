# DATADIS Mock Server

Mock server local que simula la API privada de DATADIS para el desarrollo de LYNX Lite.

## Instalación

```bash
npm install
npm start
```

Por defecto escucha en `http://localhost:3000`.

## CUPS de prueba incluidos

| CUPS | Perfil | Tarifa | Potencias |
|---|---|---|---|
| ES0031000000000001JN | Industrial | 3.0TD (maxímetro) | 50 kW P1-P6 |
| ES0031000000000002JN | Pyme | 2.0TD (ICP) | 9.2 kW |

## Endpoints implementados

- `POST /nikola-auth/tokens/login` — devuelve token JWT mock (acepta cualquier credencial)
- `GET /api-private/api/get-supplies`
- `GET /api-private/api/get-distributors-with-supplies`
- `GET /api-private/api/get-contract-detail`
- `GET /api-private/api/get-consumption-data` (con rate limit 24h simulado)
- `GET /api-private/api/get-max-power` (con rate limit 24h simulado)

## Características que simula

- **Autenticación Bearer JWT** igual que la API real
- **Curvas horarias realistas**: patrón industrial con turnos, picos en horario laboral, valles en madrugada y fines de semana planos
- **Rate limit 24h**: devuelve HTTP 429 si se repite la misma consulta antes de 24h
- **Huecos ocasionales** (~1%) y medidas estimadas (~5%) para testear robustez
- **Estructura JSON idéntica** a la documentada en el manual oficial

## Cambiar entre mock y producción en LYNX Lite

```js
const DATADIS_BASE_URL = process.env.DATADIS_URL || 'https://datadis.es';
// En desarrollo: DATADIS_URL=http://localhost:3000
// En producción: sin variable, va a datadis.es
```

## Utilidades de desarrollo

```bash
# Resetear rate limits sin reiniciar el servidor
curl -X POST http://localhost:3000/dev/reset-rate-limit
```

## Ejemplo de uso

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:3000/nikola-auth/tokens/login \
  -d "username=12345678A&password=test")

# 2. Listar suministros
curl http://localhost:3000/api-private/api/get-supplies \
  -H "Authorization: Bearer $TOKEN"

# 3. Consumo de enero 2026
curl "http://localhost:3000/api-private/api/get-consumption-data?cups=ES0031000000000001JN&distributorCode=2&startDate=2026/01&endDate=2026/01&measurementType=0&pointType=3" \
  -H "Authorization: Bearer $TOKEN"
```

## Próximos pasos

- Añadir más perfiles (autoconsumo, 6.1TD)
- Generar reactiva mensual (API V2)
- Endpoint para inyectar datos custom desde tests
