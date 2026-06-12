# LYNX Lite Mocks — Especificaciones de Contrato

**Version**: 1.0  
**Fecha**: 2026-05-29  
**Estado**: DRAFT — pendiente de aprobación

---

## Índice

1. [Arquitectura general](#arquitectura-general)
2. [DATADIS Mock — puerto 3001](#1-datadis-mock--puerto-3001)
3. [REData Mock — puerto 3002](#2-redata-mock--puerto-3002)
4. [ESIOS Mock — puerto 3003](#3-esios-mock--puerto-3003)
5. [PVGIS Mock — puerto 3004](#4-pvgis-mock--puerto-3004)
6. [Orquestación — start-all.ts](#5-orquestación--start-allts)

---

## Arquitectura general

```
lynx-lite-mocks/
├── services/
│   ├── datadis/          # Existente (Express/JS) — sin tocar
│   │   ├── server.js
│   │   ├── generators.js
│   │   └── rateLimit.js
│   ├── redata/           # Nuevo (Hono/TS)
│   │   └── server.ts
│   ├── esios/            # Nuevo (Hono/TS)
│   │   └── server.ts
│   └── pvgis/            # Nuevo (Hono/TS)
│       └── server.ts
├── start-all.ts
├── package.json
└── SPECS.md
```

**Runtime**: Bun (TypeScript nativo, sin compilación)  
**Framework nuevos servicios**: Hono  
**Inyección de puertos**: variables de entorno `PORT_DATADIS`, `PORT_REDATA`, `PORT_ESIOS`, `PORT_PVGIS`

---

## 1. DATADIS Mock — puerto 3001

> Código existente (`server.js` / `generators.js` / `rateLimit.js`) — **sin modificación**.  
> Bun ejecuta el archivo `server.js` directamente inyectando `PORT=3001` vía `process.env.PORT`.

### Autenticación

Todos los endpoints privados requieren header `Authorization: Bearer <token>`.

### Endpoints

#### `POST /nikola-auth/tokens/login`

**Body** (application/x-www-form-urlencoded):
```
username=<NIF>&password=<cualquier>
```

**Response 200** `text/plain`:
```
eyJhbGciOiJIUzI1NiJ9.MOCK_TOKEN_FOR_DEVELOPMENT.signature
```
**Response 400** si faltan `username` o `password`.

---

#### `GET /api-private/api/get-supplies`

**Query params**:
| Param | Tipo | Req |
|---|---|---|
| `authorizedNif` | string | No |
| `distributorCode` | string | No |

**Response 200** `Supply[]`:
```typescript
type Supply = {
  address: string;
  cups: string;
  postalCode: string;
  province: string;
  municipality: string;
  distributor: string;
  validDateFrom: string;     // 'YYYY/MM/DD'
  validDateTo: string;
  pointType: number;         // 2 | 3 | 5
  distributorCode: string;   // '2' | '8'
}
```

**CUPS disponibles**:
| CUPS | Perfil | Tarifa | distributorCode |
|---|---|---|---|
| ES0031000000000001JN | Industrial maxímetro 50 kW | 3.0TD | 2 |
| ES0031000000000002JN | Pyme ICP 9.2 kW | 2.0TD | 2 |
| ES0031000000000003JN | Industrial 6.1TD 120–200 kW | 6.1TD | 8 |
| ES0031000000000004JN | Industrial autoconsumo solar 80 kWp | 3.0TD | 2 |

---

#### `GET /api-private/api/get-distributors-with-supplies`

**Response 200**:
```typescript
type GetDistributorsResponse = {
  distributorCodes: string[];   // ['2', '8']
}
```

---

#### `GET /api-private/api/get-contract-detail`

**Query params** (todos string):
| Param | Req |
|---|---|
| `cups` | Sí |
| `distributorCode` | Sí |
| `authorizedNif` | No |

**Response 200** `[ContractDetail]`:
```typescript
type ContractDetail = {
  cups: string;
  distributor: string;
  marketer: string;
  tension: string;                  // '0-1kV' | '1kV-15kV' | '>=72.5kV'
  accessFare: string;               // '2.0TD' | '3.0TD' | '6.1TD'
  province: string;
  municipality: string;
  postalCode: string;
  contractedPowerkW: number[];      // 2 valores (2.0TD) | 6 valores (3/6TD)
  timeDiscrimination: string;
  modePowerControl: 'ICP' | 'Maximetro';
  startDate: string;                // 'YYYY/MM/DD'
  endDate: string;
  codeFare: string;                 // '01' | '31' | '61'
  selfConsumptionTypeCode: '00' | '41';
  selfConsumptionTypeDesc: string;
  section: string;
  subsection: null;
  partitionCoefficient: number;     // 100.0
  cau: string;                      // '' si sin autoconsumo
  installedCapacity: number;        // 0 | kWp instalados
}
```
**Response 400** si faltan `cups` o `distributorCode`.

---

#### `GET /api-private/api/get-consumption-data`

**Query params**:
| Param | Tipo | Req | Valores |
|---|---|---|---|
| `cups` | string | Sí | |
| `distributorCode` | string | Sí | |
| `startDate` | string | Sí | `YYYY/MM` |
| `endDate` | string | Sí | `YYYY/MM` |
| `measurementType` | string | Sí | `'0'`=horario · `'1'`=cuarto-horario |
| `pointType` | string | Sí | `'2'` \| `'3'` \| `'5'` |
| `authorizedNif` | string | No | |

**Response 200** `ConsumptionRecord[]`:
```typescript
type ConsumptionRecord = {
  cups: string;
  date: string;                     // 'YYYY/MM/DD'
  time: string;                     // 'HH:mm' (00:00, 00:15, 00:30, 00:45...)
  consumptionKWh: number;           // >= 0, 3 decimales
  obtainMethod: 'Real' | 'Estimada';
  surplusEnergyKWh: number;         // 0.0 si no hay autoconsumo
}
```
**Response 429** si la misma consulta se repite en < 24 h.  
**Response 400** si faltan params obligatorios.

---

#### `GET /api-private/api/get-max-power`

**Query params**:
| Param | Tipo | Req |
|---|---|---|
| `cups` | string | Sí |
| `distributorCode` | string | Sí |
| `startDate` | string | Sí | `YYYY/MM` |
| `endDate` | string | Sí | `YYYY/MM` |
| `authorizedNif` | string | No |

**Response 200** `MaxPowerRecord[]`:
```typescript
type MaxPowerRecord = {
  cups: string;
  date: string;                     // 'YYYY/MM/DD'
  time: string;                     // 'HH:mm' (cuartos de hora)
  maxPower: number;                 // vatios (W), no kW
  period: '1' | '2' | '3' | '4' | '5' | '6';
}
```
1 registro por mes × periodo. 2.0TD → 2 periodos; 3.0TD/6.xTD → 6 periodos.  
**Response 429** si la misma consulta se repite en < 24 h.

---

#### `GET /api-private/api/get-reactive-data-v2`

**Query params**:
| Param | Tipo | Req | Valores |
|---|---|---|---|
| `cups` | string | Sí | |
| `distributorCode` | string | Sí | |
| `startDate` | string | Sí | `YYYY/MM` |
| `endDate` | string | Sí | `YYYY/MM` |
| `authorizedNif` | string | No | |

**Response 200** `ReactiveRecord[]`:
```typescript
type ReactiveRecord = {
  cups: string;
  date: string;                     // 'YYYY/MM' (mes al que corresponde)
  period: '1' | '2' | '3' | '4' | '5' | '6';
  kvarh: number;                    // energía reactiva inductiva mensual, 3 decimales
}
```
Energía reactiva mensual por periodo (1 registro por mes × periodo). **Solo perfiles 3.0TD devuelven datos** (6 periodos); 2.0TD y 6.1TD devuelven `[]` (reactiva fuera de alcance).  
**Response 429** si la misma consulta se repite en < 24 h.  
**Response 400** si faltan params obligatorios.

---

#### `GET /dev/status` · `POST /dev/reset-rate-limit`

Solo para desarrollo. Sin auth. Comportamiento existente sin cambios.

---

## 2. REData Mock — puerto 3002

> Nuevo servicio **Hono + TypeScript**. Simula la API pública de REE (apidatos.ree.es).

### Autenticación: ninguna (API pública)

### Formato base: JSONAPI

Todos los endpoints devuelven `Content-Type: application/json` con esta envolvente:

```typescript
type JsonApiResponse = {
  data: {
    type: string;
    id: string;
    attributes: {
      title: string;
      'last-update': string;       // ISO8601+TZ: '2024-01-01T13:45:00.000+01:00'
      description: string;
    };
  };
  included: JsonApiSeries[];
}

type JsonApiSeries = {
  type: string;
  id: string;
  groupId: string;
  attributes: {
    title: string;
    'last-update': string;
    color: string;                 // hex: '#00a1d1'
    type: 'line' | 'bar';
    magnitude: string;             // 'MW' | 'GWh' | 'MWh'
    composite: boolean;
    'last-value': string;          // número como string: '24850'
    values: {
      value: string;               // número como string: '24500.32'
      percentage: number | null;
      datetime: string;            // ISO8601+TZ
    }[];
  };
}
```

---

### `GET /es/datos/demanda/demanda-tiempo-real`

**Query params**:
| Param | Tipo | Req | Ejemplo |
|---|---|---|---|
| `start_date` | string | Sí | `2024-01-01T00:00` |
| `end_date` | string | Sí | `2024-01-01T23:59` |
| `time_trunc` | string | Sí | `ten-minutes` \| `hour` \| `day` |
| `geo_trunc` | string | No | `electric_system` |
| `geo_limit` | string | No | `peninsular` |
| `geo_ids` | string | No | `8741` |

**Response 200**: JSONAPI con 1 elemento en `included`:
- Serie temporal de demanda en MW
- Granularidad: 1 punto cada 10 min (`ten-minutes`), cada hora (`hour`), cada día (`day`)
- Patrón sintético: base nocturna ~22.000 MW, picos laborales ~38.000 MW
- `value` como string: `"24850"`

**Response 400** `{ errors: [{ title: string }] }` si faltan `start_date`, `end_date` o `time_trunc`.

---

### `GET /es/datos/generacion/estructura-generacion`

**Query params**: idénticos a `demanda-tiempo-real`.

**Response 200**: JSONAPI con 10 elementos en `included`, uno por tecnología:

```typescript
// Tecnologías incluidas en included[]:
const GENERATION_SERIES = [
  { id: '10029', title: 'Nuclear',              color: '#ea4f3d' },
  { id: '10034', title: 'Ciclo combinado',       color: '#ff6600' },
  { id: '10030', title: 'Carbón',                color: '#6c4b24' },
  { id: '10033', title: 'Hidráulica',            color: '#0070c0' },
  { id: '10037', title: 'Eólica',                color: '#00b050' },
  { id: '10041', title: 'Solar fotovoltaica',    color: '#ffcc00' },
  { id: '10042', title: 'Solar térmica',         color: '#ffa500' },
  { id: '10044', title: 'Cogeneración',          color: '#7030a0' },
  { id: '10228', title: 'Residuos',              color: '#808080' },
  { id: '10036', title: 'Turbinación bombeo',    color: '#00bcd4' },
]
// Valores MW sintéticos proporcionales al total de demanda.
// La suma de todas las tecnologías ≈ demanda total del mismo instante.
```

**Response 400** igual que demanda.

---

## 3. ESIOS Mock — puerto 3003

> Nuevo servicio **Hono + TypeScript**. Simula la API privada ESIOS de REE (precio PVPC).

### Autenticación

**Header obligatorio**: `x-api-key: <TOKEN>`  
El mock acepta cualquier valor no vacío.

**Response 401** si falta o está vacío:
```json
{ "errors": [{ "title": "Unauthorized — missing x-api-key header" }] }
```

---

### `GET /indicators/1001`

Indicador PVPC 2.0TD — precio hora a hora en €/MWh.

**Query params**:
| Param | Tipo | Req | Default |
|---|---|---|---|
| `start_date` | string | No | hoy `T00:00:00` |
| `end_date` | string | No | hoy `T23:59:59` |
| `time_trunc` | string | No | `hour` |
| `locale` | string | No | `es` |

**Response 200**:
```typescript
type EsiosResponse = {
  indicator: {
    short_name: string;            // 'PVPC 2.0TD'
    name: string;
    time_trunc: string;            // 'hour'
    geo_trunc: string;             // 'electric_system'
    magnitude: {
      id: number;                  // 2
      name: string;                // '€/MWh'
    };
    disaggregated: boolean;        // false
    geo_ids: number[];             // [3]
    geo_names: string[];           // ['España']
    values: EsiosValue[];
  };
}

type EsiosValue = {
  value: number;                   // €/MWh · 2 decimales · rango sintético: 20–350
  datetime: string;                // ISO8601+TZ: '2024-01-01T00:00:00.000+01:00'
  datetime_utc: string;            // ISO8601 UTC
  tz_time: string;                 // 'HH:mm'
  geo_id: number;                  // 3
  geo_name: string;                // 'España'
}
```

**Patrón sintético** (24 valores/día):
- Base diurna: ~80 €/MWh
- Picos (10–14 h, 18–22 h): +40–120 €/MWh sobre base
- Valle nocturno (0–8 h): base –30 a –10 €/MWh (mínimo 20)
- Variabilidad aleatoria ±15 %

---

## 4. PVGIS Mock — puerto 3004

> Nuevo servicio **Hono + TypeScript**. Simula la API pública PVGIS de la Comisión Europea.

### Autenticación: ninguna (API pública)

---

### `GET /api/v5_2/PVcalc`

Cálculo de producción solar FV estimada a partir de coordenadas y potencia instalada.

**Query params**:
| Param | Tipo | Req | Ejemplo | Descripción |
|---|---|---|---|---|
| `lat` | number | Sí | `41.65` | Latitud decimal |
| `lon` | number | Sí | `-0.88` | Longitud decimal |
| `peakpower` | number | Sí | `10.0` | Potencia pico (kWp) |
| `pvtechchoice` | string | No | `crystSi` | `crystSi`\|`CIS`\|`CdTe`\|`Unknown`. Default: `crystSi` |
| `mountingplace` | string | No | `free` | `free`\|`building`. Default: `free` |
| `loss` | number | No | `14` | Pérdidas sistema (0–100 %). Default: `14` |
| `outputformat` | string | No | `json` | Solo `json`. Default: `json` |
| `aspect` | number | No | `0` | Azimut (–180 a 180°). Default: `0` (sur) |
| `angle` | number | No | `35` | Inclinación (0–90°). Default: `35` |

**Response 200**:
```typescript
type PvgisResponse = {
  inputs: {
    location: {
      latitude: number;
      longitude: number;
      elevation: number;              // metros, estimado
    };
    meteo_data: {
      radiation_db: 'PVGIS-SARAH2';
      year_min: 2005;
      year_max: 2020;
      use_horizon: boolean;
      horizon_db: 'DEM-calculated';
    };
    mounting_system: {
      fixed: {
        slope: { value: number; optimal: 'YES' | 'NO' };
        azimuth: { value: number; optimal: 'YES' | 'NO' };
        type: 'free-standing' | 'building-integrated';
      };
    };
    pv_module: {
      technology: string;             // 'c-Si' para crystSi
      peak_power: number;             // kWp
      system_loss: number;            // %
    };
  };
  outputs: {
    fixed: {
      type: 'time';
      timestamp: string;
      E_d: number;                    // kWh/día (media anual)
      E_m: number;                    // kWh/mes (media anual)
      E_y: number;                    // kWh/año
      'H(i)_d': number;              // irradiación diaria kWh/m²/día
      'H(i)_m': number;              // irradiación mensual kWh/m²/mes
      'H(i)_y': number;              // irradiación anual kWh/m²/año
      SD_y: number;                   // desviación estándar anual kWh/año
      l_aoi: number;                  // pérdidas AOI (%)
      l_spec: string;                 // pérdidas espectrales (%) como string
      l_tg: number;                   // pérdidas temp+irradiancia (%)
      l_total: number;                // pérdidas totales (%)
    };
    monthly: {
      fixed: {
        month: number;                // 1–12
        E_d: number;
        E_m: number;
        'H(i)_d': number;
        'H(i)_m': number;
        SD_m: number;
      }[];
    };
    totals: {
      fixed: {
        E_d: number;
        E_m: number;
        E_y: number;
        'H(i)_d': number;
        'H(i)_m': number;
        'H(i)_y': number;
        SD_y: number;
        l_aoi: number;
        l_spec: string;
        l_tg: number;
        l_total: number;
      };
    };
  };
  meta: {
    inputs: {
      description: string;
      variables: Record<string, { description: string; units: string }>;
    };
    outputs: {
      daily_energy: { description: string; units: string };
      monthly_energy: { description: string; units: string };
      yearly_energy: { description: string; units: string };
    };
  };
}
```

**Lógica sintética**:
- `irradiación_anual ≈ 1800 - (lat - 36) * 50` kWh/m²/año (aproximación peninsular)
- `E_y ≈ peakpower × irradiación_anual × (1 - loss/100) × 0.82`
- Distribución mensual: factor estacional (ene 0.55 → jun/jul 1.45 → dic 0.50)
- `elevation ≈ max(0, (lat - 37) * 200 + 300)` (simplificación)

**Response 400** si faltan `lat`, `lon` o `peakpower`:
```json
{ "status": "error", "message": "Required parameters missing: lat, lon, peakpower" }
```

---

## 5. Orquestación — `start-all.ts`

Script en la raíz de `/lynx-lite-mocks`, ejecutable con `bun run start-all.ts`.

**Comportamiento**:
1. Lanza 4 subprocesos Bun en paralelo con `Bun.spawn`
2. Inyecta `PORT` vía env a cada proceso
3. Pasa stdout/stderr con prefijo coloreado por consola:
   - `[DATADIS]` amarillo · `[REData]` azul · `[ESIOS]` verde · `[PVGIS]` magenta
4. Captura `SIGINT` para terminar todos los procesos limpiamente
5. Muestra tabla de resumen al arrancar

**Puertos** (override con variables de entorno):
| Servicio | Variable env | Puerto por defecto |
|---|---|---|
| DATADIS | `PORT_DATADIS` | 3001 |
| REData | `PORT_REDATA` | 3002 |
| ESIOS | `PORT_ESIOS` | 3003 |
| PVGIS | `PORT_PVGIS` | 3004 |
