# SPECS.md — lynx-lite

**Version**: 0.4-DRAFT  
**Fecha**: 2026-06-12  
**Estado**: Pendiente de aprobación

---

## Índice

1. [Arquitectura general](#1-arquitectura-general)
2. [Sistema de usuarios y autenticación](#2-sistema-de-usuarios-y-autenticación)
3. [M01 — Pre-factura automática](#3-m01--pre-factura-automática)
4. [M02 — Optimización de potencia contratada](#4-m02--optimización-de-potencia-contratada)
5. [M03 — Alertas y detección de anomalías](#5-m03--alertas-y-detección-de-anomalías)
6. [M04 — KPI de coste energético por unidad producida](#6-m04--kpi-de-coste-energético-por-unidad-producida)
7. [M05 — Huella de carbono](#7-m05--huella-de-carbono)
8. [M06 — Simulación de autoconsumo solar](#8-m06--simulación-de-autoconsumo-solar)
9. [Convenciones de test](#9-convenciones-de-test)

---

## 1. Arquitectura general

### 1.1 Estructura del monorepo

```
lynx-lite-monorepo/
├── package.json                  # npm workspaces (ver abajo)
├── tsconfig.base.json            # TypeScript base: strict, target ES2022
├── lynx-lite-mocks/              # Ya existente — mocks de DATADIS, ESIOS, REData, PVGIS
└── lynx-lite/
    ├── apps/
    │   ├── api/                  # Node.js + Express + Apollo Server (GraphQL). Incluye modo demo en memoria (sin DBs)
    │   ├── worker/               # Node.js + node-cron (jobs de sincronización y backfill)
    │   └── web/                  # Angular 17 — front mínimo (login + pre-factura) para enseñar M01
    └── packages/
        ├── pricing-engine/       # Módulo de cálculo puro (sin I/O)
        └── data-collector/       # Adaptadores DATADIS + ESIOS → InfluxDB (compartido por api y worker)
```

**npm workspaces** — el `package.json` raíz declara:

```json
{
  "workspaces": [
    "lynx-lite-mocks",
    "lynx-lite/apps/api",
    "lynx-lite/apps/worker",
    "lynx-lite/packages/pricing-engine",
    "lynx-lite/packages/data-collector"
  ]
}
```

*(`lynx-lite/apps/web` **no** es un workspace npm: es un proyecto Angular independiente con su propia
toolchain y `node_modules`, para aislar las dependencias de Angular del resto del monorepo.)*

El `package.json` raíz además expone scripts de orquestación: `build` (compila packages → `prisma generate`
→ apps, en ese orden), `build:web` (build del front) y `test` (suites de los 4 paquetes backend).

### 1.2 Backend — apps/api

- **Framework**: Express + Apollo Server
- **ORM**: Prisma → PostgreSQL
- **Series temporales**: InfluxDB client v2 (bucket `lynx-lite`)
- **Patrón**: los resolvers GraphQL orquestan consultas a InfluxDB + PostgreSQL.
  No acceden directamente a APIs externas — eso lo hace `@lynx-lite/data-collector`.
- **Adaptadores externos** (uno por servicio, controlados por variables de entorno):

| Adaptador | Variable de entorno | Default producción |
|-----------|--------------------|--------------------|
| Datadis   | `DATADIS_URL`      | `https://datadis.es` |
| ESIOS     | `ESIOS_URL`        | `https://api.esios.ree.es` |
| REData    | `REDATA_URL`       | `https://apidatos.ree.es` |
| PVGIS     | `PVGIS_URL`        | `https://re.jrc.ec.europa.eu` |

- **Modo demo (sin DBs)**: `npm run demo` (`src/demo.ts`) arranca el mismo servidor GraphQL pero con
  datos **en memoria** — inyecta un store en memoria vía `setPrisma()` y un `PreInvoiceDataSource`
  sintético vía `setDataSource()`, sin Postgres ni InfluxDB. El motor de cálculo es el real; sirve solo
  para demostrar M01. Login sembrado: `dominion@lynx.local` / `dominion`.

### 1.3 Pricing Engine — packages/pricing-engine

- Módulo **puro**: recibe datos ya cargados, devuelve resultado de cálculo.
- Sin dependencias externas: no llama a APIs, no usa Prisma, no accede a InfluxDB.
- Totalmente testeable en aislamiento con datos sintéticos.

### 1.3b Data Collector — packages/data-collector

- Adaptadores HTTP para DATADIS y ESIOS.
- Transforma las respuestas y escribe en InfluxDB.
- No tiene singletons propios: recibe el cliente InfluxDB como parámetro (inyección).
- Compartido por `apps/api` (ingesta on-demand) y `apps/worker` (jobs programados).
- Testeable en aislamiento mockeando el cliente HTTP y el cliente InfluxDB.

### 1.3c Worker — apps/worker

- **Proceso independiente** de `apps/api` — arranca por separado.
- **Scheduler**: `node-cron` integrado — ejecuta los jobs de sincronización periódica (ver §1.5).
- Usa `@lynx-lite/data-collector` para las llamadas a DATADIS y ESIOS.
- Comparte las mismas bases de datos (PostgreSQL + InfluxDB) que `apps/api`; la coordinación de estado se hace a través de los campos de PostgreSQL (p.ej. `Supply.backfillStatus`).
- Sin GraphQL ni endpoints HTTP propios.

### 1.3d Web — apps/web

- **Angular 17** (standalone). Front mínimo para enseñar M01: pantalla de **login** y pantalla de
  **pre-factura** (selector de CUPS, período, desglose de líneas y totales, banner de huecos).
- Cliente GraphQL propio (`HttpClient`, sin Apollo) contra `apps/api` en `http://localhost:4000/graphql`.
- **No es un workspace npm**: proyecto independiente con su propia toolchain y `node_modules`. Se
  construye/arranca por separado (`npm start` / `npm run build` dentro de `apps/web`, o `build:web` desde raíz).
- Pensado para apuntar al **modo demo** del api (§1.2); crecerá hasta ser el front definitivo.

### 1.4 Flujo de ingesta (DATADIS/ESIOS → InfluxDB)

Antes de calcular una pre-factura, el sistema verifica si InfluxDB ya contiene los
datos del período solicitado. Si faltan:

1. El resolver invoca al servicio de ingesta correspondiente.
2. El servicio de ingesta llama a DATADIS (o ESIOS) vía el adaptador HTTP.
3. Los datos se transforman y se escriben en InfluxDB.
4. El cálculo procede usando InfluxDB como única fuente de verdad de series temporales.

Esta separación protege de los rate limits de DATADIS (429 en < 24 h para la misma
consulta) y mantiene los resolvers GraphQL desacoplados de las APIs externas.

### 1.5 Política de sincronización con DATADIS

#### Schedules de ingesta

| Dato | Frecuencia | Detalle |
|------|-----------|---------|
| Curvas de consumo (`hourly_consumption`) | Diario a las **06:00** | `apps/worker` — solicita solo D-2; comprueba en InfluxDB qué fechas ya existen antes de llamar |
| Maxímetro (`max_power`) | Semanal los **lunes** | `apps/worker` — retraso variable por distribuidora; el pull semanal cubre esa variabilidad |
| Reactiva mensual (`monthly_reactive`) | Mensual el **día 5** | `apps/worker` — solo suministros con `tariff === T_3_0TD`. Solicita el mes anterior (M-1). Si la distribuidora devuelve array vacío, no se escribe nada y el campo queda sin dato. |
| Contratos | Mensual el **día 5** + on-demand | `apps/worker` (programado) + `apps/api` (on-demand si se detecta cambio de comercializadora) |
| Backfill de onboarding | **Una sola vez**, al crear un `Supply` vía `createSupply` | `apps/worker` — lanzado en background inmediatamente tras el alta; `backfillStatus` en `Supply` refleja el progreso. Solicita los últimos 2 años de `hourly_consumption` y `max_power` para ese CUPS. Para suministros `T_3_0TD`, incluye también los últimos 2 años de `monthly_reactive`. |

#### Restricción anti-repetición (HTTP 429)

DATADIS bloquea con HTTP 429 cualquier consulta que repita exactamente los mismos
parámetros en menos de 24 horas. Reglas de obligado cumplimiento:

1. Antes de cualquier llamada a DATADIS, consultar InfluxDB (o PostgreSQL para contratos)
   para determinar qué rango falta realmente.
2. El dato se persiste en InfluxDB/PostgreSQL **inmediatamente** tras su descarga.
3. El sistema **nunca** llama a DATADIS para un rango que ya tiene almacenado localmente.

#### Gestión de huecos (`gap`)

Un punto horario se considera **hueco** si:
- DATADIS lo devuelve con `obtainMethod === "Estimada"`, **o**
- DATADIS no devuelve dato para ese timestamp.

El punto se escribe en InfluxDB con `gap="true"` (y `estimated="true"` si procede, ver §2.3).
Para **visualización** se aplica imputación por perfil: valor del mismo slot horario de la
semana anterior. Los valores imputados **nunca** se usan en el cálculo de factura.

> **Comportamiento en facturación cuando hay huecos**: si el período solicitado contiene
> puntos con `gap="true"`, la pre-factura se calcula usando el valor DATADIS disponible
> (aunque sea estimado). Si el punto no existe en absoluto (solo imputado), se eleva
> `NO_CONSUMPTION_DATA`. El guardado **nunca se bloquea** por gaps.
>
> La pre-factura expone `gapHoursCount` (total de horas afectadas) y `gapPeriodsJson`
> (desglose por período). La UI muestra un banner amarillo no bloqueante:
> *"Esta prefactura contiene X horas con datos estimados o no disponibles. El resultado
> puede diferir de la factura real."* El PDF incluye siempre un disclaimer al pie con el
> número exacto de horas y los períodos afectados.

### 1.6 Variables de entorno

```
# APIs externas (default: mocks en dev)
DATADIS_URL=http://localhost:3001
ESIOS_URL=http://localhost:3003
REDATA_URL=http://localhost:3002
PVGIS_URL=http://localhost:3004

# Base de datos relacional
DATABASE_URL=postgresql://lynx:lynx@localhost:5432/lynxlite

# InfluxDB
INFLUXDB_URL=http://localhost:8086
INFLUXDB_TOKEN=dev-token
INFLUXDB_ORG=lynx
INFLUXDB_BUCKET=lynx-lite

# Credenciales DATADIS
DATADIS_NIF=12345678A
DATADIS_PASSWORD=mock-pass

# Credencial ESIOS
ESIOS_API_KEY=mock-key
```

---

## 2. Sistema de usuarios y autenticación

### 2.1 Roles

| Rol | Scope | Descripción |
|-----|-------|-------------|
| `DOMINION` | Plataforma | Superadmin. Vista global de clientes, supplies y usuarios. Aprueba solicitudes de nuevo supply. CRUD total sobre cualquier entidad. Solo habrá una cuenta con este rol. |
| `ADMIN` | Cliente | Control total sobre su cliente. Crea, modifica y borra usuarios (`ADMIN`, `GESTOR`, `USUARIO`) dentro del cliente. Solicita nuevos supplies (requieren aprobación DOMINION). |
| `GESTOR` | Supply | Ve datos y usuarios de su supply. Crea y borra `USUARIO` de su supply. Ve otros `GESTOR` del mismo supply pero no puede modificarlos. |
| `USUARIO` | Supply | Solo lectura de datos de su supply. No puede ver ni gestionar usuarios. |

### 2.2 Matriz de permisos

| Acción | DOMINION | ADMIN | GESTOR | USUARIO |
|--------|:--------:|:-----:|:------:|:-------:|
| Ver todos los clientes | ✅ | ❌ | ❌ | ❌ |
| Ver su cliente | ✅ | ✅ | — | — |
| CRUD clientes | ✅ | ❌ | ❌ | ❌ |
| Ver todos los supplies | ✅ | Solo los del cliente | Solo el suyo | Solo el suyo |
| Solicitar nuevo supply | ✅ | ✅ | ❌ | ❌ |
| Aprobar supply | ✅ | ❌ | ❌ | ❌ |
| Ver usuarios | ✅ | Del cliente | Del supply | ❌ |
| Crear usuarios | ✅ | `ADMIN`/`GESTOR`/`USUARIO` del cliente | `USUARIO` del supply | ❌ |
| Modificar usuarios | ✅ | Cualquiera del cliente | ❌ | ❌ |
| Borrar usuarios | ✅ | Cualquiera del cliente | `USUARIO` del supply | ❌ |
| Ver pre-facturas | ✅ | Del cliente | Del supply | Del supply |
| Calcular/guardar pre-facturas | ✅ | Del cliente | Del supply | ❌ |

> Un `GESTOR` ve a otros `GESTOR` del mismo supply (solo lectura) pero no puede editarlos ni borrarlos.

### 2.3 Modelo de datos

```prisma
enum UserRole {
  DOMINION
  ADMIN
  GESTOR
  USUARIO
}

enum SupplyStatus {
  PENDING_APPROVAL  // solicitud enviada, pendiente de DOMINION
  ACTIVE
  INACTIVE
}

model User {
  id           String     @id @default(uuid())
  email        String     @unique
  passwordHash String
  name         String
  role         UserRole

  // ADMIN: apunta a su cliente. GESTOR/USUARIO: cliente del supply (denormalizado para queries).
  // DOMINION: null.
  clientId     String?
  client       Client?    @relation(fields: [clientId], references: [id])

  // GESTOR/USUARIO: apunta a su supply. DOMINION/ADMIN: null.
  supplyId     String?
  supply       Supply?    @relation(fields: [supplyId], references: [id])

  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}
```

**Cambio en `Supply`** — añadir campo de estado para el flujo de solicitud:

```prisma
// Campos adicionales en el model Supply existente:
status      SupplyStatus @default(ACTIVE)
requestedBy String?      // userId del ADMIN que creó la solicitud (null si creado por DOMINION)
```

**Invariantes de integridad:**
- `DOMINION`: `clientId = null`, `supplyId = null`.
- `ADMIN`: `clientId != null`, `supplyId = null`.
- `GESTOR` / `USUARIO`: `clientId != null`, `supplyId != null`. El `supplyId` debe pertenecer al `clientId`.
- Un supply pertenece a exactamente un cliente (`Client → Supply` es 1:N).
- La cadena de acceso es siempre `Client → Supply → User`. No hay acceso cross-client.

### 2.4 Autenticación — JWT

- **Login**: mutation GraphQL `login(email, password) → AuthPayload`.
- **Token**: JWT firmado con `JWT_SECRET`. Payload:

```typescript
{
  sub: string;       // userId
  role: UserRole;
  clientId?: string; // presente para ADMIN, GESTOR, USUARIO
  supplyId?: string; // presente para GESTOR, USUARIO
  iat: number;
  exp: number;       // 8 horas
}
```

- El token se envía en header `Authorization: Bearer <token>`.
- El middleware de Express inyecta el usuario decodificado en el contexto Apollo antes de cada resolver.

### 2.5 Variables de entorno adicionales

```
JWT_SECRET=cambia-esto-en-produccion
JWT_EXPIRY=8h
```

### 2.6 Esquema GraphQL — autenticación y usuarios

```graphql
enum UserRole {
  DOMINION
  ADMIN
  GESTOR
  USUARIO
}

enum SupplyStatus {
  PENDING_APPROVAL
  ACTIVE
  INACTIVE
}

type AuthPayload {
  token: String!
  user:  User!
}

type User {
  id:        ID!
  email:     String!
  name:      String!
  role:      UserRole!
  clientId:  String
  supplyId:  String
  createdAt: String!
}

input LoginInput {
  email:    String!
  password: String!
}

input CreateUserInput {
  email:    String!
  password: String!
  name:     String!
  role:     UserRole!
  clientId: String   # requerido para ADMIN/GESTOR/USUARIO
  supplyId: String   # requerido para GESTOR/USUARIO
}

input UpdateUserInput {
  name:     String
  password: String
  role:     UserRole
}

type Mutation {
  login(input: LoginInput!): AuthPayload!

  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!

  # ADMIN solicita nuevo supply; queda en PENDING_APPROVAL hasta que DOMINION lo apruebe
  requestSupply(cups: String!, address: String, tariff: Tariff!): Supply!

  # Solo DOMINION
  approveSupply(supplyId: ID!): Supply!
  rejectSupply(supplyId: ID!): Boolean!
}

type Query {
  me: User!
  users(clientId: String, supplyId: String): [User!]!
  user(id: ID!): User
}
```

**Errores esperados adicionales:**

| Código | Condición |
|--------|-----------|
| `UNAUTHENTICATED` | Request sin token o token inválido/expirado |
| `FORBIDDEN` | Token válido pero rol insuficiente para la operación |
| `USER_NOT_FOUND` | El `id` de usuario no existe |
| `EMAIL_ALREADY_EXISTS` | Intento de crear usuario con email duplicado |
| `SUPPLY_SCOPE_MISMATCH` | El `supplyId` no pertenece al `clientId` indicado |

### 2.7 Casos de test — autenticación y autorización

> Capa: Integration. Herramienta: Vitest + Supertest.
> Aplica a todos los módulos — se ejecuta como suite compartida.

---

#### TC-AUTH-001 — Login correcto

**Módulo**: resolver `login` — Integration

**Input**: `mutation { login(input: { email: "admin@client.com", password: "correct" }) { token user { role } } }`

**Output esperado**:
- HTTP 200, `data.login.token` presente y decodificable como JWT válido
- Payload JWT contiene `{ sub, role: "ADMIN", clientId, iat, exp }`
- `exp - iat === 8 × 3600`

---

#### TC-AUTH-002 — Login con contraseña incorrecta

**Módulo**: resolver `login` — Integration

**Input**: password errónea para email existente

**Output esperado**: error GraphQL con `extensions.code === "UNAUTHENTICATED"`

---

#### TC-AUTH-003 — Request sin token

**Módulo**: middleware JWT — Integration

**Input**: query `me` sin header `Authorization`

**Output esperado**: error con `extensions.code === "UNAUTHENTICATED"`

---

#### TC-AUTH-004 — Token expirado

**Módulo**: middleware JWT — Integration

**Input**: JWT firmado con `exp` en el pasado (fixture de test)

**Output esperado**: error con `extensions.code === "UNAUTHENTICATED"`

---

#### TC-AUTH-005 — USUARIO intenta savePreInvoice (FORBIDDEN)

**Módulo**: resolver `savePreInvoice` — Integration

**Setup**: usuario con `role = USUARIO`, `supplyId` vinculado al CUPS consultado

**Input**: `mutation savePreInvoice` con CUPS de su supply

**Output esperado**: error con `extensions.code === "FORBIDDEN"`

---

#### TC-AUTH-006 — ADMIN accede a supply de otro cliente (FORBIDDEN)

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: usuario con `role = ADMIN`, `clientId = "client-A"`; CUPS pertenece a `client-B`

**Input**: `query calculatePreInvoice` con el CUPS de `client-B`

**Output esperado**: error con `extensions.code === "FORBIDDEN"`

---

#### TC-AUTH-007 — GESTOR calcula pre-factura de su propio supply (OK)

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: usuario con `role = GESTOR`, `supplyId` vinculado al CUPS consultado; datos disponibles en InfluxDB

**Input**: `query calculatePreInvoice` con su CUPS

**Output esperado**: respuesta `PreInvoice` correcta (sin error de autorización)

---

## 3. M01 — Pre-factura automática

### 3.1 Fuentes de datos

| Fuente | Endpoint | Dato obtenido |
|--------|----------|---------------|
| DATADIS | `GET /api-private/api/get-consumption-data` | Curva horaria de consumo (kWh por hora) |
| DATADIS | `GET /api-private/api/get-contract-detail` | Potencias contratadas por período, modo de control de potencia |
| DATADIS | `GET /api-private/api/get-max-power` | Potencia máxima registrada por período por mes (en **Vatios**) |
| DATADIS | `GET /api-private/api/get-reactive-data-v2` | Energía reactiva mensual por período (kVArh). Solo 3.0TD. |
| ESIOS   | `GET /indicators/1001` | Precio PVPC horario (€/MWh, header `x-api-key` requerido) |
| PostgreSQL | maestros regulatorios | Peajes CNMC, cargos TED, IEE, IVA, alquiler contador, tarifas reactiva, término de exceso de potencia (`tepp4-5`, solo maxímetro) — versionados por fecha |

> **Nota de alcance reactiva**: DATADIS V2 expone `get-reactive-data-v2`, que devuelve kVArh
> mensual agregado por período. Solo aplica a suministros con potencia contratada > 15 kW
> (3.0TD). Para 2.0TD, `reactiveEnergy` es siempre `null`.
> **Precondición de producción**: verificar que el distribuidor del CUPS reporta datos en este
> endpoint antes de activarlo. Si la respuesta es array vacío, se trata como sin reactiva.
>
> **Nota tarifaria**: ESIOS indicador 1001 (PVPC) se aplica a ambas tarifas (2.0TD y 3.0TD)
> en esta versión como simplificación. En la realidad, 3.0TD usa precios de mercado OMIE.
> La pre-factura es una **estimación** y esta limitación debe reflejarse en la UI.

### 3.2 Modelos Prisma

```prisma
// ─── Entidades de cliente y suministro ───────────────────────────────────────

model Client {
  id         String   @id @default(uuid())
  name       String
  vatNumber  String   @unique
  email      String?
  supplies   Supply[]
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}

model Supply {
  id             String         @id @default(uuid())
  cups           String         @unique
  clientId       String
  client         Client         @relation(fields: [clientId], references: [id])
  address        String?
  tariff         Tariff
  backfillStatus BackfillStatus @default(PENDING)
  contracts      Contract[]
  preInvoices    PreInvoice[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}

enum BackfillStatus {
  PENDING   // alta reciente, backfill aún no iniciado
  RUNNING   // backfill en curso
  DONE      // histórico de 2 años disponible en InfluxDB
  FAILED    // error durante el backfill; reintentar manualmente
}

enum Tariff {
  T_2_0TD
  T_3_0TD
}

// Snapshot del contrato vigente (origen: DATADIS get-contract-detail)
model Contract {
  id                  String    @id @default(uuid())
  supplyId            String
  supply              Supply    @relation(fields: [supplyId], references: [id])
  validFrom           DateTime
  validTo             DateTime?
  // 2.0TD: solo P1 y P2. 3.0TD: P1–P6. Nulos para períodos no aplicables.
  contractedPowerP1   Float
  contractedPowerP2   Float
  contractedPowerP3   Float?
  contractedPowerP4   Float?
  contractedPowerP5   Float?
  contractedPowerP6   Float?
  modePowerControl    PowerControl
  hasSurplus          Boolean      @default(false)
  createdAt           DateTime     @default(now())
}

enum PowerControl {
  ICP        // Interruptor Control Potencia — sin excesos posibles
  MAXIMETRO  // Maxímetro — excesos posibles
}

// ─── Maestros regulatorios (versionados por fecha de vigencia) ───────────────

// Peajes de acceso a red (CNMC)
model TollRate {
  id        String    @id @default(uuid())
  tariff    Tariff
  period    Int       // 1–6
  rateType  RateType
  eur       Float     // €/kW/día (POWER) | €/kWh (ENERGY)
  validFrom DateTime
  validTo   DateTime?
  @@unique([tariff, period, rateType, validFrom])
}

// Cargos regulatorios (TED / Gobierno)
model ChargeRate {
  id        String    @id @default(uuid())
  tariff    Tariff
  period    Int
  rateType  RateType
  eur       Float     // €/kW/día (POWER) | €/kWh (ENERGY)
  validFrom DateTime
  validTo   DateTime?
  @@unique([tariff, period, rateType, validFrom])
}

enum RateType {
  POWER
  ENERGY
}

model IEERate {
  id        String    @id @default(uuid())
  rate      Float     // sin porcentaje: 0.0511269632 = 5.11269632%
  validFrom DateTime
  validTo   DateTime?
}

model VATRate {
  id        String    @id @default(uuid())
  rate      Float     // 0.21 = 21%
  validFrom DateTime
  validTo   DateTime?
}

model MeterRentalRate {
  id         String    @id @default(uuid())
  tariff     Tariff
  eurPerDay  Float
  validFrom  DateTime
  validTo    DateTime?
}

// Término de exceso de potencia tepp4-5 (€/kW·día), tipos de medida 4 y 5.
// Art. 9.4.b.1 Circular CNMC 3/2020 consolidada (1/2025). Compartido por M01 y M02.
// ⚠️ Los valores que se siembran hoy (seed.ts / demo) son SINTÉTICOS de test; los oficiales
// se toman de la Resolución de peajes vigente del BOE y se cargan versionados por fecha.
model ExcessPowerRate {
  id        String    @id @default(uuid())
  tariff    Tariff
  period    Int       // 1–6
  eurPerDay Float      // tepp4-5 en €/kW·día
  validFrom DateTime
  validTo   DateTime?
  @@unique([tariff, period, validFrom])
}

// Tarifas de energía reactiva inductiva (Circular CNMC 3/2020, Art. 9.5)
// Solo dos tramos (tier 1 y 2); el tramo 0 (sin cargo) no necesita registro.
model ReactiveEnergyRate {
  id        String    @id @default(uuid())
  tier      Int       // 1 = 0,80 ≤ cos φ < 0,95 | 2 = cos φ < 0,80
  eur       Float     // €/kVArh sobre el exceso respecto al 33% de la activa
  validFrom DateTime
  validTo   DateTime?
  @@unique([tier, validFrom])
}

// ─── Pre-facturas calculadas ──────────────────────────────────────────────────

model PreInvoice {
  id                  String           @id @default(uuid())
  supplyId            String
  supply              Supply           @relation(fields: [supplyId], references: [id])
  periodFrom          DateTime
  periodTo            DateTime
  tariff              Tariff
  // Partidas (€)
  powerTerm           Float
  energyTerm          Float
  excessPower         Float            @default(0)
  reactiveEnergy      Float?           // null = 2.0TD o distribuidor sin datos V2
  surplusCompensation Float?           // null = no aplica
  meterRental         Float
  subtotal            Float            // ieeBase + ieeAmount + meterRental (antes de IVA)
  ieeAmount           Float
  vatAmount           Float
  total               Float
  gapHoursCount       Int              @default(0)  // horas con gap="true" o estimada en el período
  gapPeriodsJson      Json?            // desglose por período: {"P1": 2, "P2": 0, ...}; null si gapHoursCount === 0
  lines               PreInvoiceLine[]
  createdAt           DateTime         @default(now())
}

model PreInvoiceLine {
  id           String     @id @default(uuid())
  preInvoiceId String
  preInvoice   PreInvoice @relation(fields: [preInvoiceId], references: [id])
  concept      String
  period       Int?       // 1–6 | null si es transversal (IEE, IVA, alquiler)
  quantity     Float
  unit         String     // "kW·día" | "kWh" | "día" | "kW" | "%"
  unitPrice    Float
  amount       Float
  sortOrder    Int
}
```

### 3.3 Esquema InfluxDB

**Measurement: `hourly_consumption`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Tag: `cups` | string | Identificador del punto de suministro |
| Tag: `period` | string | `"P1"` – `"P6"` según discriminación horaria |
| Tag: `estimated` | string | `"true"` si DATADIS devolvió `obtainMethod === "Estimada"` |
| Tag: `gap` | string | `"true"` si el punto es estimado por DATADIS **o** fue imputado por ausencia (ver §1.5) |
| Field: `kwh` | float | Consumo neto de red en el intervalo (kWh); valor imputado si `gap="true"` y DATADIS no devolvió dato |
| Field: `surplus_kwh` | float | Energía excedente volcada a red (0 si no hay autoconsumo) |
| Timestamp | UTC | Inicio del intervalo (resolución 1 h ó 15 min) |

> El campo `period` se asigna en el momento de la ingesta usando el mismo
> calendario tarifario simplificado que el mock (ver generadores.js línea 74–93).
> Esta asignación aplica para 2.0TD y 3.0TD. La tarifa 6.1TD está fuera de alcance en v1.
>
> Relación entre tags de calidad: `estimated="true"` y `gap="true"` son ortogonales.
> Un punto puede ser `estimated="true", gap="true"` (DATADIS lo devolvió como estimado),
> `estimated="false", gap="true"` (ausente en DATADIS, imputado por nosotros), o
> `estimated="false", gap="false"` (dato medido fiable). La factura solo usa puntos
> con `gap="false"`; para los demás, ver comportamiento definido en §1.5.

**Measurement: `max_power`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Tag: `cups` | string | |
| Tag: `period` | string | `"P1"` – `"P6"` (power periods) |
| Field: `kw` | float | Potencia máxima registrada ese mes (ya convertida de W a kW) |
| Timestamp | UTC | Instante en que se registró el máximo (del campo `date`+`time` de DATADIS) |

> DATADIS `get-max-power` devuelve `maxPower` en **Vatios** (W). El adaptador de
> ingesta divide por 1000 antes de escribir en InfluxDB.
>
> El mock devuelve 1 registro por mes × período, no series cuarto-horarias.
> `max_power` almacena ese único máximo mensual por período.

**Measurement: `pvpc_price`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Tag: `period` | string | `"P1"` – `"P3"` para 2.0TD; `"P1"` – `"P6"` para 3.0TD (asignado en ingesta) |
| Field: `eur_kwh` | float | Precio en €/kWh (convertido de €/MWh ÷ 1000) |
| Timestamp | UTC | Hora a la que aplica el precio |

> ESIOS devuelve precios en **€/MWh**. El adaptador divide por 1000 antes de escribir.

**Measurement: `monthly_reactive`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Tag: `cups` | string | |
| Tag: `period` | string | `"P1"` – `"P6"` |
| Field: `kvarh` | float | Energía reactiva inductiva mensual (kVArh) |
| Timestamp | UTC | Primer instante UTC del mes al que corresponde el dato |

> DATADIS `get-reactive-data-v2` devuelve datos **mensuales** agregados (no horarios).
> Un registro por mes × período. El adaptador escribe con timestamp del inicio de mes.
> Si la distribuidora devuelve array vacío para un CUPS, no se escribe ningún punto
> y el pricing-engine recibe `reactiveEnergy: null`.

### 3.4 Algoritmo de cálculo — paso a paso

El `pricing-engine` recibe una estructura de datos pre-cargada y devuelve el resultado.
No hace I/O. El resolver del API es responsable de cargar los datos antes de invocar
el engine.

#### Interfaz del pricing-engine

```typescript
// ─── Input ────────────────────────────────────────────────────────────────────

interface PricingInput {
  tariff: 'T_2_0TD' | 'T_3_0TD';
  periodDays: number;
  modePowerControl: 'ICP' | 'MAXIMETRO';

  // 2.0TD: { P1, P2 } | 3.0TD: { P1, P2, P3, P4, P5, P6 }
  contractedPower: Record<string, number>; // kW

  // 2.0TD: { P1, P2, P3 } | 3.0TD: { P1..P6 } (energy periods)
  consumption: Record<string, number>;     // kWh totales del período por período

  // 2.0TD: { P1, P2 } | 3.0TD: { P1..P6 } (power periods)
  // Null si modePowerControl === 'ICP' (no aplica)
  maxPower: Record<string, number> | null; // kW (ya convertido de W)

  // Término de exceso tepp4-5 (€/kW·día) por power period. Origen: ExcessPowerRate.
  // {} si modePowerControl === 'ICP' (no se usa).
  excessRates: Record<string, number>;

  // Precio PVPC medio ponderado por energía consumida en cada período
  // 2.0TD: { P1, P2, P3 } | 3.0TD: { P1..P6 }
  pvpcPrice: Record<string, number>;       // €/kWh

  tollRates: {
    power: Record<string, number>;  // €/kW/día, indexado por power period
    energy: Record<string, number>; // €/kWh, indexado por energy period
  };
  chargeRates: {
    power: Record<string, number>;  // €/kW/día
    energy: Record<string, number>; // €/kWh
  };

  ieeRate: number;           // sin porcentaje: 0.0511269632
  vatRate: number;           // 0.21
  meterRentalPerDay: number; // €/día

  // kVArh por período P1–P5 (origen: monthly_reactive en InfluxDB).
  // Null si tarifa 2.0TD o si la distribuidora no reporta datos V2.
  reactiveEnergy: Record<string, number> | null;
  // Null cuando reactiveEnergy es null.
  reactiveRates: { tier1Eur: number; tier2Eur: number; } | null;

  hasSurplus: boolean;       // true solo si autoconsumo con excedentes
}

// ─── Output ───────────────────────────────────────────────────────────────────

interface PricingResult {
  powerTerm: number;           // €
  energyTerm: number;          // €
  excessPower: number;         // €
  reactiveEnergy: number;      // € (0 si reactiveEnergy input es null)
  surplusCompensation: number; // € (≤ 0 si compensa; 0 si no aplica)
  meterRental: number;         // €
  ieeBase: number;             // €
  ieeAmount: number;           // €
  subtotal: number;            // ieeBase + ieeAmount + meterRental
  vatAmount: number;           // €
  total: number;               // €
  lines: PricingLine[];
}

interface PricingLine {
  concept: string;
  period: number | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  sortOrder: number;
}
```

#### Paso 1 — Término de potencia

Para cada power period `Pi` activo según la tarifa (P1–P2 para 2.0TD; P1–P6 para 3.0TD):

```
totalPowerRate[Pi] = tollRates.power[Pi] + chargeRates.power[Pi]  // €/kW/día
powerTerm[Pi]      = contractedPower[Pi] × totalPowerRate[Pi] × periodDays
```

```
powerTerm = Σ powerTerm[Pi]
```

#### Paso 2 — Término de energía

Para cada energy period `Pi` activo según la tarifa (P1–P3 para 2.0TD; P1–P6 para 3.0TD):

```
totalEnergyRate[Pi] = pvpcPrice[Pi] + tollRates.energy[Pi] + chargeRates.energy[Pi]  // €/kWh
energyTerm[Pi]      = consumption[Pi] × totalEnergyRate[Pi]
```

```
energyTerm = Σ energyTerm[Pi]
```

#### Paso 3 — Excesos de potencia (fórmula regulatoria real, tipos 4 y 5)

Implementado por la función pura compartida `computeExcessTerm()` (art. 9.4.b.1 de la
Circular CNMC 3/2020 consolidada con 1/2025, vigente desde 1-abril-2025). La usan tanto M01
(un tramo = período de facturación) como M02 (un tramo por mes).

Solo aplica si `modePowerControl === 'MAXIMETRO'` y `maxPower !== null` (con ICP no hay excesos:
salta el interruptor). Para cada power period `Pi` con `maxPower[Pi] > contractedPower[Pi]`:

```
excessKw[Pi]    = maxPower[Pi] − contractedPower[Pi]
excessPower[Pi] = excessRates[Pi] × excessKw[Pi] × periodDays   // tepp4-5 €/kW·día × kW × n
```

```
excessPower = Σ excessPower[Pi]   // FEP = Σp tepp4-5 × (Pdp − Pcp) × n
```

> **Sin** raíz cuadrada, **sin** factor ×2 y **sin** banda del 1.05: la banda 85%/105% era del
> RD 1164/2001 (derogado) y el ×2/√Σ son de fórmulas previas a 2025 o de tipos 1–3 (6.xTD, fuera
> de alcance). Se cobra desde el primer kW por encima de lo contratado, sobre el término de exceso
> `tepp4-5` (no sobre el peaje+cargo), adicionalmente al término de potencia base.
>
> `maxPower[Pi]` es la potencia máxima demandada del período (`Pdp`, del measurement `max_power`).
> El resolver exige `ExcessPowerRate` para todos los períodos solo si el contrato es MAXIMETRO;
> si falta, eleva `REGULATORY_DATA_MISSING`.

#### Paso 4 — Energía reactiva

Si `reactiveEnergy === null`: `reactiveEnergy_total = 0`.

> El resolver pasa `reactiveEnergy: null` cuando: (a) la tarifa es 2.0TD, (b) la distribuidora
> no reporta el dato, o (c) el período de factura no coincide exactamente con uno o más meses
> naturales completos. No se aplica prorrateo en ningún caso.

Si `reactiveEnergy !== null` (3.0TD con datos disponibles), para cada período `Pi` activo
(P1–P5; **P6 excluido** — precio regulado = 0 €/kVArh):

```
Si consumption[Pi] === 0 o reactiveEnergy[Pi] === 0:
  reactiveCharge[Pi] = 0
  continuar

ratio[Pi]  = reactiveEnergy[Pi] / consumption[Pi]   // kVArh / kWh
exceso[Pi] = max(0, reactiveEnergy[Pi] − 0,33 × consumption[Pi])

Si ratio[Pi] ≤ 0,33:                              // cos φ ≥ 0,95 — sin cargo
  reactiveCharge[Pi] = 0
Si 0,33 < ratio[Pi] ≤ 0,75:                      // 0,80 ≤ cos φ < 0,95
  reactiveCharge[Pi] = exceso[Pi] × reactiveRates.tier1Eur
Si ratio[Pi] > 0,75:                              // cos φ < 0,80
  reactiveCharge[Pi] = exceso[Pi] × reactiveRates.tier2Eur
```

> Los umbrales 0,33 y 0,75 son exactamente tan(arccos(0,95)) ≈ 0,329 y tan(arccos(0,80)) = 0,75.
> La normativa usa el 33% como umbral redondeado; se aplica ese valor literal.

```
reactiveEnergy_total = Σ reactiveCharge[Pi]
```

#### Paso 5 — Compensación por excedentes

Solo aplica si `hasSurplus === true` y hay datos de excedentes en DATADIS.

En v1: `surplusCompensation = 0` (lógica reservada para módulo 6 — autoconsumo).

#### Paso 6 — Base imponible IEE y cálculo de IEE

```
ieeBase   = powerTerm + energyTerm + excessPower + reactiveEnergy + surplusCompensation
ieeAmount = ieeBase × ieeRate
```

#### Paso 7 — Alquiler de contador

```
meterRental = meterRentalPerDay × periodDays
```

El alquiler **no** entra en la base del IEE, pero **sí** entra en la base del IVA.

#### Paso 8 — Subtotal y IVA

```
subtotal  = ieeBase + ieeAmount + meterRental
vatAmount = subtotal × vatRate
```

#### Paso 9 — Total

```
total = subtotal + vatAmount
```

#### Notas de precisión y redondeo

- Todos los importes se calculan en `number` (float64) **sin redondeo intermedio**.
  Cualquier valor que alimente un cálculo posterior conserva todos sus decimales.
- Solo se redondea a 2 decimales **en la presentación final** (UI / PDF). El engine nunca redondea.
- Los tests validan con tolerancia `±0.01 €`.

> **Aviso sobre las tablas de valores esperados de §3.6**: los subtotales de las tablas
> (`powerTerm`, `energyTerm`, etc.) se muestran redondeados a 2 decimales **solo por legibilidad**.
> NO deben recomputarse sumando los importes por período ya redondeados — eso introduce error de
> redondeo acumulado que en 3.0TD (6 períodos) supera la tolerancia de ±0.01 €. El valor de
> referencia es siempre el cálculo sin redondeo intermedio (p.ej. `energyTerm` de TC-PRE-003 = 2187.231 €,
> no la suma 389.04+452.62+…=2187.25). Los tests del `pricing-engine` validan contra el valor sin redondear.

### 3.5 Esquema GraphQL

```graphql
enum Tariff {
  T_2_0TD
  T_3_0TD
}

enum PowerControl {
  ICP
  MAXIMETRO
}

enum BackfillStatus {
  PENDING
  RUNNING
  DONE
  FAILED
}

type Supply {
  id:             ID!
  cups:           String!
  clientId:       String!
  address:        String
  tariff:         Tariff!
  backfillStatus: BackfillStatus!
  createdAt:      String!
}

input CreateSupplyInput {
  cups:      String!
  clientId:  String!
  address:   String
  tariff:    Tariff!
}

type PreInvoiceLine {
  concept:   String!
  period:    Int
  quantity:  Float!
  unit:      String!
  unitPrice: Float!
  amount:    Float!
  sortOrder: Int!
}

type PreInvoice {
  id:                  ID!
  supplyId:            String!
  periodFrom:          String!        # ISO 8601: "YYYY-MM-DD"
  periodTo:            String!        # ISO 8601: "YYYY-MM-DD"
  tariff:              Tariff!
  powerTerm:           Float!
  energyTerm:          Float!
  excessPower:         Float!
  reactiveEnergy:      Float          # null si 2.0TD o distribuidora sin datos V2
  surplusCompensation: Float          # null si no aplica
  meterRental:         Float!
  subtotal:            Float!
  ieeAmount:           Float!
  vatAmount:           Float!
  total:               Float!
  gapHoursCount:       Int!            # 0 si no hay huecos
  gapPeriodsJson:      String          # JSON serializado; null si gapHoursCount === 0
  lines:               [PreInvoiceLine!]!
  createdAt:           String!
}

input PreInvoiceInput {
  cups:       String!
  periodFrom: String!  # "YYYY-MM-DD"
  periodTo:   String!  # "YYYY-MM-DD"
}

type Query {
  # Consulta un suministro por ID. Usado para polling de backfillStatus tras createSupply.
  supply(id: ID!): Supply

  # Calcula sin persistir. Si faltan datos en InfluxDB, los ingesta primero.
  calculatePreInvoice(input: PreInvoiceInput!): PreInvoice!

  # Recupera una pre-factura ya guardada.
  preInvoice(id: ID!): PreInvoice

  # Lista pre-facturas de un suministro, ordenadas por periodFrom desc.
  preInvoices(supplyId: String!, limit: Int, offset: Int): [PreInvoice!]!
}

type Mutation {
  # Crea el suministro y lanza el backfill de 2 años en background.
  # backfillStatus inicial: PENDING → RUNNING → DONE | FAILED
  createSupply(input: CreateSupplyInput!): Supply!

  # Calcula y persiste en PostgreSQL. Idempotente por (supplyId, periodFrom, periodTo).
  savePreInvoice(input: PreInvoiceInput!): PreInvoice!

  deletePreInvoice(id: ID!): Boolean!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` | El suministro aún no ha iniciado el backfill histórico |
| `BACKFILL_RUNNING` | El backfill está en curso; reintentar en unos minutos |
| `BACKFILL_FAILED` | El backfill falló; usar `retriggerBackfill` antes de calcular |
| `CONTRACT_NOT_FOUND` | No hay contrato vigente para el período |
| `NO_CONSUMPTION_DATA` | InfluxDB no tiene datos y DATADIS tampoco los devuelve |
| `REGULATORY_DATA_MISSING` | Faltan maestros regulatorios para algún día del período |

### 3.6 Casos de test — contrato de implementación

> Los tests del pricing-engine son unitarios (sin I/O).
> Los tests del resolver son de integración con mocks de Prisma e InfluxDB.

---

#### TC-PRE-001 — 2.0TD básico, sin excesos, sin reactiva

**Módulo**: `pricing-engine`  
**Descripción**: cálculo completo de una pre-factura 2.0TD de enero (31 días) con consumo
típico de pyme, sin excesos de potencia (ICP), sin reactiva.

**Input**:

```typescript
{
  tariff: 'T_2_0TD',
  periodDays: 31,
  modePowerControl: 'ICP',
  contractedPower: { P1: 10.0, P2: 10.0 },
  consumption:     { P1: 500.0, P2: 800.0, P3: 1200.0 },
  maxPower: null,
  excessRates: {},  // ICP: no se usa
  pvpcPrice:       { P1: 0.14000, P2: 0.10000, P3: 0.06000 },
  tollRates: {
    power:  { P1: 0.115327, P2: 0.002572 },
    energy: { P1: 0.007215, P2: 0.004860, P3: 0.000841 }
  },
  chargeRates: {
    power:  { P1: 0.011000, P2: 0.001000 },
    energy: { P1: 0.003000, P2: 0.002000, P3: 0.001000 }
  },
  ieeRate: 0.0511269632,
  vatRate: 0.21,
  meterRentalPerDay: 0.026114,
  reactiveEnergy: null,
  reactiveRates: null,
  hasSurplus: false
}
```

**Output esperado** (tolerancia ±0.01 €):

| Campo | Cálculo | Valor esperado |
|-------|---------|----------------|
| `powerTerm` (P1) | 10.0 × (0.115327+0.011000) × 31 | 39.16 € |
| `powerTerm` (P2) | 10.0 × (0.002572+0.001000) × 31 | 1.11 € |
| **`powerTerm`** | | **40.27 €** |
| `energyTerm` (P1) | 500.0 × (0.14000+0.007215+0.003000) | 75.11 € |
| `energyTerm` (P2) | 800.0 × (0.10000+0.004860+0.002000) | 85.49 € |
| `energyTerm` (P3) | 1200.0 × (0.06000+0.000841+0.001000) | 74.21 € |
| **`energyTerm`** | | **234.81 €** |
| `excessPower` | ICP — no aplica | **0.00 €** |
| `meterRental` | 0.026114 × 31 | **0.81 €** |
| `ieeBase` | 40.27 + 234.81 | **275.08 €** |
| `ieeAmount` | 275.08 × 0.0511269632 | **14.06 €** |
| `subtotal` | 275.08 + 14.06 + 0.81 | **289.95 €** |
| `vatAmount` | 289.95 × 0.21 | **60.89 €** |
| **`total`** | | **350.84 €** |

**Verificaciones adicionales**:
- `lines` contiene exactamente 8 registros (2 potencia + 3 energía + alquiler + IEE + IVA).
- `lines` ordenadas por `sortOrder` ascendente.
- Suma de `lines[*].amount` === `total` (tolerancia ±0.01).
- `reactiveEnergy === 0` (`reactiveEnergy: null` en input → 0 en output, sin error).

---

#### TC-PRE-002 — 2.0TD con exceso de potencia en P1

**Módulo**: `pricing-engine`  
**Descripción**: mismo escenario que TC-PRE-001 pero con maxímetro y potencia máxima
registrada en P1 que supera la contratada (fórmula real art. 9.4.b.1).

**Input**: igual que TC-PRE-001 excepto:

```typescript
{
  modePowerControl: 'MAXIMETRO',
  maxPower: { P1: 11.5, P2: 9.5 },
  excessRates: { P1: 0.060000, P2: 0.060000 }  // tepp4-5 €/kW·día (sintético de test)
  // P1: 11.5 kW > 10.0 contratada → exceso
  // P2: 9.5 kW ≤ 10.0 contratada → sin exceso
}
```

**Output esperado** (tolerancia ±0.01 €):

| Campo | Cálculo | Valor esperado |
|-------|---------|----------------|
| `powerTerm` | igual TC-PRE-001 | 40.27 € |
| `energyTerm` | igual TC-PRE-001 | 234.81 € |
| `excessPower` (P1) | (11.5−10.0) × 0.060000 × 31 | **2.79 €** |
| `excessPower` (P2) | 0 (9.5 ≤ 10.0 contratada) | 0.00 € |
| **`excessPower`** | | **2.79 €** |
| `ieeBase` | powerTerm + energyTerm + 2.79 (sin redondeo) | **277.86 €** |
| `ieeAmount` | 277.86 × 0.0511269632 | **14.21 €** |
| `subtotal` | 277.86 + 14.21 + 0.81 | **292.88 €** |
| `vatAmount` | 292.88 × 0.21 | **61.50 €** |
| **`total`** | | **354.38 €** |

> Valores idénticos a los del test `pricing-engine` TC-PRE-002 (validados sin redondeo intermedio, ver §3.4).

**Verificaciones adicionales**:
- `lines` contiene 9 registros (añade la línea de exceso P1 respecto a TC-PRE-001).

---

#### TC-PRE-003 — 3.0TD sin excesos (6 períodos)

**Módulo**: `pricing-engine`  
**Descripción**: industrial 3.0TD, 30 días, 6 períodos de energía y potencia, sin excesos.

**Input**:

```typescript
{
  tariff: 'T_3_0TD',
  periodDays: 30,
  modePowerControl: 'MAXIMETRO',
  contractedPower: { P1: 50.0, P2: 50.0, P3: 50.0, P4: 50.0, P5: 50.0, P6: 50.0 },
  consumption:     { P1: 2000, P2: 3000, P3: 4000, P4: 1500, P5: 2500, P6: 5000 },
  maxPower:        { P1: 48.0, P2: 47.0, P3: 49.0, P4: 46.0, P5: 48.0, P6: 47.0 },
  // Todos ≤ 50.0 contratada → sin excesos (con MAXIMETRO requiere excessRates, aquí no hay exceso)
  excessRates:     { P1: 0.070000, P2: 0.060000, P3: 0.040000, P4: 0.040000, P5: 0.020000, P6: 0.020000 },
  pvpcPrice:       { P1: 0.18, P2: 0.14, P3: 0.10, P4: 0.16, P5: 0.12, P6: 0.07 },
  tollRates: {
    power:  { P1: 0.115327, P2: 0.082748, P3: 0.024894, P4: 0.024894, P5: 0.003695, P6: 0.002572 },
    energy: { P1: 0.009518, P2: 0.006872, P3: 0.003558, P4: 0.003558, P5: 0.002122, P6: 0.000841 }
  },
  chargeRates: {
    power:  { P1: 0.015000, P2: 0.010000, P3: 0.006000, P4: 0.006000, P5: 0.002000, P6: 0.001000 },
    energy: { P1: 0.005000, P2: 0.004000, P3: 0.003000, P4: 0.003000, P5: 0.002000, P6: 0.001000 }
  },
  ieeRate: 0.0511269632,
  vatRate: 0.21,
  meterRentalPerDay: 0.039660,  // 3.0TD tiene tarifa de alquiler de equipo diferente
  reactiveEnergy: null,
  reactiveRates: null,
  hasSurplus: false
}
```

**Output esperado** (tolerancia ±0.01 €):

| Campo | Valor esperado |
|-------|----------------|
| `powerTerm` (P1) | 50 × 0.130327 × 30 = 195.49 € |
| `powerTerm` (P2) | 50 × 0.092748 × 30 = 139.12 € |
| `powerTerm` (P3) | 50 × 0.030894 × 30 = 46.34 € |
| `powerTerm` (P4) | 50 × 0.030894 × 30 = 46.34 € |
| `powerTerm` (P5) | 50 × 0.005695 × 30 = 8.54 € |
| `powerTerm` (P6) | 50 × 0.003572 × 30 = 5.36 € |
| **`powerTerm`** | | **441.19 €** |
| `energyTerm` (P1) | 2000 × 0.194518 = 389.04 € |
| `energyTerm` (P2) | 3000 × 0.150872 = 452.62 € |
| `energyTerm` (P3) | 4000 × 0.106558 = 426.23 € |
| `energyTerm` (P4) | 1500 × 0.166558 = 249.84 € |
| `energyTerm` (P5) | 2500 × 0.124122 = 310.31 € |
| `energyTerm` (P6) | 5000 × 0.071841 = 359.21 € |
| **`energyTerm`** | | **2187.25 €** |
| `excessPower` | Sin excesos | **0.00 €** |
| `meterRental` | 0.039660 × 30 | **1.19 €** |
| `ieeBase` | 441.19 + 2187.25 | **2628.44 €** |
| `ieeAmount` | 2628.44 × 0.0511269632 | **134.38 €** |
| `subtotal` | 2628.44 + 134.38 + 1.19 | **2764.01 €** |
| `vatAmount` | 2764.01 × 0.21 | **580.44 €** |
| **`total`** | | **3344.45 €** |

---

#### TC-PRE-004 — 3.0TD con exceso en P1

**Módulo**: `pricing-engine`  
**Descripción**: igual que TC-PRE-003 pero `maxPower.P1 = 58.0 kW` (supera la contratada 50 kW).

**Input**: igual TC-PRE-003 excepto `maxPower: { P1: 58.0, P2: 47.0, ..., P6: 47.0 }` y
`excessRates: { P1: 0.070000, P2: 0.060000, P3: 0.040000, P4: 0.040000, P5: 0.020000, P6: 0.020000 }` (tepp4-5 €/kW·día, sintético de test).

**Output esperado**:

| Campo | Cálculo | Valor esperado |
|-------|---------|----------------|
| `powerTerm` | igual TC-PRE-003 | 441.19 € |
| `energyTerm` | igual TC-PRE-003 (sin redondeo 2187.231) | 2187.23 € |
| `excessPower` (P1) | (58.0−50.0) × 0.070000 × 30 | **16.80 €** |
| `ieeBase` | 441.195 + 2187.231 + 16.80 (sin redondeo) | **2645.23 €** |
| `ieeAmount` | 2645.23 × 0.0511269632 | **135.24 €** |
| `subtotal` | 2645.23 + 135.24 + 1.19 | **2781.66 €** |
| `vatAmount` | 2781.66 × 0.21 | **584.15 €** |
| **`total`** | | **3365.81 €** |

> Valores idénticos a los del test `pricing-engine` TC-PRE-004 (validados sin redondeo intermedio, ver §3.4).

---

#### TC-PRE-005 — Validación: período sin datos de consumo

**Módulo**: GraphQL resolver (`calculatePreInvoice`)  
**Descripción**: la query se invoca con un CUPS válido para un período en el que
InfluxDB no tiene datos y DATADIS devuelve array vacío.

**Input**:
```graphql
query {
  calculatePreInvoice(input: {
    cups: "ES0031000000000002JN",
    periodFrom: "2020-01-01",
    periodTo: "2020-01-31"
  })
}
```

**Output esperado**:
- Error GraphQL con `extensions.code === "NO_CONSUMPTION_DATA"`.
- No se crea ningún registro en PostgreSQL.

---

#### TC-PRE-006 — Validación: CUPS inexistente

**Módulo**: GraphQL resolver (`calculatePreInvoice`)  
**Input**: CUPS `"ES0099999999999999XX"` (no existe en PostgreSQL).

**Output esperado**:
- Error GraphQL con `extensions.code === "SUPPLY_NOT_FOUND"`.

---

#### TC-PRE-007 — Persistencia idempotente (savePreInvoice)

**Módulo**: GraphQL resolver (`savePreInvoice`)  
**Descripción**: invocar `savePreInvoice` dos veces con el mismo input debe
retornar el mismo registro (sin duplicados en PostgreSQL).

**Condición**: la segunda llamada con el mismo `(cups, periodFrom, periodTo)` devuelve
el `PreInvoice` ya existente en lugar de crear uno nuevo (upsert por `(supplyId, periodFrom, periodTo)`).

**Output esperado**:
- Ambas llamadas retornan un `PreInvoice` con el mismo `id`.
- PostgreSQL contiene exactamente 1 registro para ese período.

---

#### TC-PRE-008 — Conversión de unidades desde DATADIS

**Módulo**: adaptador de ingesta (unit test)  
**Descripción**: verificar que la conversión W → kW y €/MWh → €/kWh se aplica
correctamente antes de escribir en InfluxDB.

**Input (simulado)**:
```typescript
// Registro de maxPower de DATADIS
{ cups: 'ES0031000000000001JN', date: '2025/01/15', time: '10:00', maxPower: 48000, period: '1' }

// Precio ESIOS
{ value: 180.5, datetime: '2025-01-15T09:00:00.000Z' }
```

**Output esperado en InfluxDB**:
```typescript
// max_power measurement
{ kw: 48.0, tags: { cups: 'ES0031000000000001JN', period: 'P1' } }

// pvpc_price measurement
{ eur_kwh: 0.1805, tags: { period: 'P1' } }  // 180.5 / 1000
```

---

#### TC-PRE-009 — 3.0TD con reactiva en tramo 1 (0,80 ≤ cos φ < 0,95 en P1)

**Módulo**: `pricing-engine`  
**Descripción**: igual que TC-PRE-003 pero con datos de reactiva. Solo P1 supera el umbral
del 33% (ratio 0,45), el resto queda por debajo.

**Input**: igual que TC-PRE-003 excepto:

```typescript
{
  reactiveEnergy: { P1: 900, P2: 500, P3: 800, P4: 400, P5: 600, P6: 1000 },
  reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 }
  // P1: 900/2000 = 0,45 → tier 1 | P2–P5: ratio ≤ 0,33 → sin cargo | P6: excluido
}
```

**Output esperado** (tolerancia ±0.01 €):

| Campo | Cálculo | Valor esperado |
|-------|---------|----------------|
| `powerTerm` | igual TC-PRE-003 | 441.19 € |
| `energyTerm` | igual TC-PRE-003 | 2187.25 € |
| `excessPower` | Sin excesos | 0.00 € |
| `reactiveEnergy` (P1) | (900 − 0,33×2000) × 0,041554 = 240 × 0,041554 | **9.97 €** |
| `reactiveEnergy` (P2–P5) | ratio ≤ 0,33 → 0 | 0.00 € |
| **`reactiveEnergy`** | | **9.97 €** |
| `ieeBase` | 441.19 + 2187.25 + 9.97 | **2638.41 €** |
| `ieeAmount` | 2638.41 × 0.0511269632 | **134.89 €** |
| `subtotal` | 2638.41 + 134.89 + 1.19 | **2774.49 €** |
| `vatAmount` | 2774.49 × 0.21 | **582.64 €** |
| **`total`** | | **3357.13 €** |

**Verificaciones adicionales**:
- `lines` contiene 16 registros (15 de TC-PRE-003 + 1 línea de reactiva P1).

---

#### TC-PRE-010 — 3.0TD con reactiva en tramo 2 (cos φ < 0,80 en P1)

**Módulo**: `pricing-engine`  
**Descripción**: igual que TC-PRE-003 pero P1 tiene ratio 0,80 (supera el umbral de 0,75
que corresponde a cos φ < 0,80), activando el tramo 2 más penalizador.

**Input**: igual que TC-PRE-003 excepto:

```typescript
{
  reactiveEnergy: { P1: 1600, P2: 500, P3: 800, P4: 400, P5: 600, P6: 1000 },
  reactiveRates: { tier1Eur: 0.041554, tier2Eur: 0.062332 }
  // P1: 1600/2000 = 0,80 → tier 2 | resto sin cargo
}
```

**Output esperado** (tolerancia ±0.01 €):

| Campo | Cálculo | Valor esperado |
|-------|---------|----------------|
| `powerTerm` | igual TC-PRE-003 | 441.19 € |
| `energyTerm` | igual TC-PRE-003 | 2187.25 € |
| `excessPower` | Sin excesos | 0.00 € |
| `reactiveEnergy` (P1) | (1600 − 0,33×2000) × 0,062332 = 940 × 0,062332 | **58.59 €** |
| **`reactiveEnergy`** | | **58.59 €** |
| `ieeBase` | 441.19 + 2187.25 + 58.59 | **2687.03 €** |
| `ieeAmount` | 2687.03 × 0.0511269632 | **137.38 €** |
| `subtotal` | 2687.03 + 137.38 + 1.19 | **2825.60 €** |
| `vatAmount` | 2825.60 × 0.21 | **593.38 €** |
| **`total`** | | **3418.98 €** |

**Verificaciones adicionales**:
- `lines` contiene 16 registros (igual que TC-PRE-009 — solo añade línea reactiva P1).

---

### 3.7 Casos de test adicionales — ciclo de vida, ingesta, calidad de datos

---

#### TC-PRE-011 — createSupply lanza backfill en background

**Módulo**: resolver `createSupply` — Integration

**Input**: `mutation createSupply` con CUPS nuevo, `tariff: T_2_0TD`

**Output esperado**:
- `Supply` creado en PostgreSQL con `backfillStatus = PENDING` (o `RUNNING` si el job arrancó antes de la respuesta)
- Job de backfill registrado para ese CUPS (verificable con spy sobre el scheduler)
- La mutation retorna inmediatamente sin esperar al backfill

---

#### TC-PRE-012 — calculatePreInvoice con backfillStatus PENDING

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply existente con `backfillStatus = PENDING`

**Output esperado**: error GraphQL `BACKFILL_PENDING`

---

#### TC-PRE-013 — calculatePreInvoice con backfillStatus RUNNING

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply con `backfillStatus = RUNNING`

**Output esperado**: error GraphQL `BACKFILL_RUNNING`

---

#### TC-PRE-014 — calculatePreInvoice con backfillStatus FAILED

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply con `backfillStatus = FAILED`

**Output esperado**: error GraphQL `BACKFILL_FAILED`

---

#### TC-PRE-015 — Anti-429: datos en InfluxDB evitan llamada a DATADIS

**Módulo**: servicio de ingesta — Integration

**Setup**: InfluxDB ya contiene `hourly_consumption` para el rango completo solicitado

**Acción**: invocar `calculatePreInvoice` para ese rango

**Output esperado**:
- El adaptador DATADIS **no recibe ninguna llamada** HTTP (verificable con spy/mock)
- El cálculo usa los datos de InfluxDB sin error

---

#### TC-PRE-016 — DATADIS devuelve HTTP 429

**Módulo**: adaptador DATADIS — Integration

**Setup**: mock de DATADIS configurado para responder 429; InfluxDB vacío para el rango

**Output esperado**:
- El adaptador no reintenta automáticamente
- El error se propaga como `NO_CONSUMPTION_DATA`
- No se escribe nada en InfluxDB

---

#### TC-PRE-017 — Ingesta: obtainMethod="Estimada" → tags correctos en InfluxDB

**Módulo**: adaptador DATADIS — Unit

**Input (simulado)**:
```typescript
{ cups: 'ES0031000000000001JN', date: '2025/01/15', time: '10:00',
  consumptionKWh: 2.5, obtainMethod: 'Estimada', surplusEnergyKWh: 0 }
```

**Output esperado** (measurement `hourly_consumption`):
```typescript
{ kwh: 2.5, tags: { gap: 'true', estimated: 'true', cups: 'ES0031000000000001JN', period: 'P1' } }
```

---

#### TC-PRE-018 — Ingesta: timestamp ausente en DATADIS → imputado

**Módulo**: servicio de imputación — Integration

**Setup**: DATADIS no devuelve dato para las 03:00 del 2025-01-15; dato del mismo slot 7 días antes disponible en InfluxDB

**Output esperado** (measurement `hourly_consumption`):
```typescript
{ kwh: <valor_slot_semana_anterior>, tags: { gap: 'true', estimated: 'false', ... } }
```

- El punto imputado **no se usa** en el cálculo de pre-factura
- Si todos los puntos del período son imputados, el resolver eleva `NO_CONSUMPTION_DATA`

---

#### TC-PRE-019 — Pre-factura con horas de gap: no bloquea, expone métricas

**Módulo**: resolver `savePreInvoice` — Integration

**Setup**: InfluxDB contiene 3 puntos con `gap="true"` en el período (2 estimados por DATADIS, 1 solo imputado)

**Output esperado**:
- `gapHoursCount === 3`
- `gapPeriodsJson` refleja el desglose por período (ej. `{"P1": 2, "P2": 1}`)
- La pre-factura se guarda sin error
- Los 2 puntos con dato DATADIS (aunque estimado) entran en el cálculo
- El 1 punto solo imputado no entra en el cálculo pero sí se contabiliza en `gapHoursCount`

---

#### TC-PRE-021 — DATADIS devuelve array vacío para reactiva → null en resolver

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply con tarifa `T_3_0TD`; mock `get-reactive-data-v2` devuelve `[]`

**Output esperado**: `preInvoice.reactiveEnergy === null`

---

#### TC-PRE-022 — Período parcial (no meses naturales completos) → reactiva null

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply `T_3_0TD` con datos de reactiva disponibles; período solicitado 2025-01-15 a 2025-02-14

**Output esperado**: `preInvoice.reactiveEnergy === null`

> La reactiva se obtiene mensual agregada desde DATADIS; sin al menos un mes natural completo no es prorrateable.

---

#### TC-PRE-023 — Período P6 excluido del cálculo de energía reactiva

**Módulo**: pricing-engine — Unit

**Input**: igual que TC-PRE-009 pero con `reactiveEnergy.P6 = 5000` (valor deliberadamente alto)

**Output esperado**:
- `reactiveCharge[P6] === 0` (precio regulado P6 = 0 €/kVArh)
- `result.reactiveEnergy` idéntico al de TC-PRE-009

---

#### TC-PRE-024 — Sin contrato vigente para el período → CONTRACT_NOT_FOUND

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: Supply sin `Contract` activo que cubra el período solicitado

**Output esperado**: error GraphQL `CONTRACT_NOT_FOUND`

---

#### TC-PRE-025 — Falta maestro regulatorio → REGULATORY_DATA_MISSING

**Módulo**: resolver `calculatePreInvoice` — Integration

**Setup**: `TollRate` o `ChargeRate` sin registro que cubra algún día del período solicitado

**Output esperado**: error GraphQL `REGULATORY_DATA_MISSING`

---

#### TC-PRE-026 — Job diario consulta InfluxDB antes de llamar a DATADIS

**Módulo**: scheduler (cron diario 06:00) — Integration

**Setup**:
- Supply A: InfluxDB tiene datos de D-2
- Supply B: InfluxDB no tiene datos de D-2

**Ejecución**: disparar el job manualmente en el test

**Output esperado**:
- Supply A: adaptador DATADIS **no recibe llamada** para D-2
- Supply B: adaptador DATADIS **sí recibe llamada** solo para D-2 (no para fechas anteriores ya cubiertas)

---

#### TC-PRE-027 — Backfill de onboarding: scope correcto de datos solicitados

**Módulo**: job de backfill — Integration

**Setup A** (T_3_0TD): Supply recién creado

**Verificaciones**:
- Se solicitan 2 años de `hourly_consumption`
- Se solicitan 2 años de `max_power`
- Se solicitan 2 años de `monthly_reactive` (exclusivo de 3.0TD)
- Tras completar, `backfillStatus = DONE`

**Setup B** (T_2_0TD): Supply recién creado

**Verificaciones**:
- Se solicitan 2 años de `hourly_consumption` y `max_power`
- `monthly_reactive` **no se solicita**
- Tras completar, `backfillStatus = DONE`

---

---

## 4. M02 — Optimización de potencia contratada

Analiza el histórico de demanda de un suministro y recomienda la **potencia óptima a
contratar por período** (P1–P2 en 2.0TD; P1–P6 en 3.0TD), estima el **ahorro anual** de
aplicar la recomendación y diagnostica **sobredimensionamiento** e **infradimensionamiento**.
Es una herramienta de análisis (no factura): no escribe en InfluxDB ni llama a APIs externas
durante el cálculo.

### 4.0 Decisiones de diseño (premisas de este módulo)

> Estas decisiones se tomaron al especificar M02 porque el brief asumía datos cuarto-horarios
> del maxímetro que DATADIS **no** expone de forma fiable. Quedan registradas para poder revertirlas.
>
> **Fundamento regulatorio**: la fórmula de excesos y la metodología de optimización siguen la
> **Circular CNMC 3/2020** consolidada con la **Circular 1/2025** (vigente desde 1-abril-2025).
> El art. 8.9 de la Circular define un procedimiento oficial de optimización de potencias
> (minimizar la facturación de peajes dada la curva de carga) — M02 se alinea con esa metodología.

> **Alcance de tarifas y excesos**: el producto soporta 2.0TD y 3.0TD, que corresponden a
> **puntos de medida tipo 4 y 5**. La fórmula de excesos aplicable es la del art. 9.4.b.1 (tipos
> 4 y 5). La fórmula con raíz cuadrada y coeficientes `Kp` (art. 9.4.b.2, tipos 1–3) aplica a
> 6.xTD y queda **fuera de alcance** en v1. En **2.0TD con control por ICP no hay excesos**
> (salta el interruptor): el término de potencia demandada es 0; solo aplica con maxímetro.

> **Fase previa (corrección de M01) — HECHA**: el modelo de excesos de M01 (§3.4 Paso 3) ya se
> ha reemplazado por `computeExcessTerm()` con la fórmula regulatoria real (`FEP = Σp tepp4-5 ×
> (Pdp − Pcp) × n`), con el nuevo maestro `ExcessPowerRate`. M01 y M02 comparten esa función, de
> modo que la pre-factura y el ahorro usan exactamente el mismo cálculo de excesos. Las tablas
> TC-PRE-002 y TC-PRE-004 se recalcularon; suite verde.

1. **Fuente de la potencia para el percentil**: se usa la **curva de carga** ya ingestada
   (`hourly_consumption`), derivando potencia por intervalo `kW = kWh / horasDelIntervalo`.
   El percentil 99 solo tiene sentido estadístico sobre una distribución (~8 760 puntos/año);
   sobre los 12–24 máximos mensuales de `max_power` degeneraría en el máximo. **Limitación
   asumida**: la potencia derivada de energía horaria es la *media del intervalo*, no el pico
   instantáneo del maxímetro, por lo que **subestima**. Se corrige con el coeficiente de uplift
   del punto siguiente. `max_power` se mantiene como contraste y como señal del diagnóstico.

2. **Coeficiente de granularidad (1.05)**: si la curva está en resolución **horaria**, la
   potencia óptima se multiplica por **1.05** para compensar la pérdida de pico frente al
   cuarto de hora real. Si la curva está en **15 min**, el uplift es **1.00** (sin corrección).

3. **Regla de infradimensionamiento reinterpretada**: el brief la define como "excesos en
   > 2 % de los **cuartos de hora** del mes". Al no disponer de cuartos de hora, se reinterpreta
   como "> `undersizeRatio` (default **2 %**) de los **intervalos de la curva** del mes con
   potencia derivada > potencia contratada", reforzada por `max_power` mensual > Pc.

4. **Ahorro coherente con M01 (fórmula real)**: tanto el término de potencia como el de excesos
   se calculan con la **misma** lógica que la pre-factura, mediante funciones puras compartidas
   exportadas por el `pricing-engine`:
   - `computePowerTerm()` — refactor del Paso 1 de §3.4 (término de potencia contratada).
   - `computeExcessTerm()` — **nueva** función con la fórmula regulatoria real para tipos 4 y 5
     (art. 9.4.b.1 de la Circular 3/2020 consolidada): `FEP = Σp tepp4-5 × (Pdp − Pcp) × n`,
     donde `tepp4-5` está en €/kW·día (maestro `ExcessPowerRate`, versionado), `Pdp` es la
     potencia máxima demandada del período (= `max_power`), `Pcp` la contratada y `n` los días.
     **Sin** raíz cuadrada, **sin** ×2, **sin** `Kp` (eso era la fórmula previa a 2025 o la de
     tipos 1–3). Esta función reemplaza el modelo erróneo del Paso 3 de §3.4 en la fase previa.

### 4.0bis Prerrequisitos de implementación (Fase 1)

Estado al inicio de M02 (tras la Fase 0, commit de corrección de excesos de M01):

- **Ya existe**: `computeExcessTerm()` exportado por `pricing-engine` (`src/excess.ts`), el maestro
  `ExcessPowerRate` (Prisma + seed + demo store), y `loadRegulatoryRates(..., { requireExcess })`.
- **Falta extraer (parte de Fase 1)**: `computePowerTerm()` **no existe todavía** como función
  exportada. Hay que refactorizar el Paso 1 de §3.4 (bucle del término de potencia en
  `pricing-engine/src/engine.ts`) a una función pura `computePowerTerm(power, tollPower, chargePower, days)`
  y exportarla, de modo que M01 (`calculate`) y M02 la compartan. No debe cambiar ningún resultado
  de M01 (refactor sin cambio de comportamiento; los TC-PRE siguen verdes).
- **Migraciones Prisma**: el repo nunca se ha ejecutado contra Postgres real (no hay carpeta
  `prisma/migrations`). Los modelos nuevos de M02 (`PowerOptimization`, `PowerOptimizationPeriod`)
  y la relación inversa en `Supply` se añaden al `schema.prisma` y se aplican con `prisma migrate dev`
  cuando exista BD; en tests se usa el cliente mockeado.
- **Patrón de tests**: Vitest; mock de Prisma con `vi.hoisted` (no `vitest-mock-extended`, ver §9.3).

### 4.1 Fuentes de datos

| Fuente | Endpoint / origen | Dato obtenido | Uso en M02 |
|--------|-------------------|---------------|------------|
| InfluxDB | measurement `hourly_consumption` | Curva horaria de consumo (kWh por hora y período) | Construcción de la muestra de potencia y del percentil 99 |
| InfluxDB | measurement `max_power` | Máximo mensual por período (kW) | Diagnóstico de dimensionamiento y contraste del percentil |
| PostgreSQL | `Contract` (último vigente) | Potencias contratadas actuales, `modePowerControl`, `validFrom` | Comparación actual vs óptima y fecha del último cambio |
| PostgreSQL | `TollRate` + `ChargeRate` (POWER) | Peajes y cargos €/kW/día por período | Cálculo del ahorro (término de potencia) |
| PostgreSQL | `ExcessPowerRate` (nuevo maestro) | Término de exceso `tepp4-5` €/kW·día por tarifa y período | Cálculo del coste de excesos (`computeExcessTerm`) |

> **Sin ingesta nueva**: M02 consume datos que ya carga M01 (`hourly_consumption`, `max_power`)
> mediante el backfill de onboarding y los jobs periódicos (§1.5). No añade measurements ni jobs.
> No se llama a DATADIS/ESIOS durante `calculatePowerOptimization`.
>
> **Histórico mínimo**: el análisis requiere al menos **12 meses** de curva para que el percentil
> y la detección de 6 meses consecutivos sean significativos. Ventana recomendada: **12–24 meses**.
> Si hay menos, se eleva `INSUFFICIENT_HISTORY`.

### 4.2 Modelos Prisma

```prisma
// ─── Maestro regulatorio: término de exceso de potencia (tipos 4 y 5) ────────
// Introducido en la fase previa de corrección de excesos de M01; lo consumen M01 y M02.
// Valores oficiales (€/kW·día) de la Resolución de peajes vigente, versionados por fecha.
model ExcessPowerRate {
  id        String   @id @default(uuid())
  tariff    Tariff
  period    Int      // 1–6
  eurPerDay Float    // tepp4-5 en €/kW·día
  validFrom DateTime
  validTo   DateTime?
  @@unique([tariff, period, validFrom])
}

// ─── Resultado de optimización de potencia (M02) ─────────────────────────────

model PowerOptimization {
  id                 String   @id @default(uuid())
  supplyId           String
  supply             Supply   @relation(fields: [supplyId], references: [id])
  tariff             Tariff
  analysisFrom       DateTime
  analysisTo         DateTime
  granularity        String    // "hourly" | "quarter" — resolución de la curva analizada
  upliftFactor       Float     // 1.05 (hourly) | 1.00 (quarter)
  sampleCount        Int       // nº de puntos de potencia usados en el percentil
  // Ahorro estimado anualizado (€/año)
  fixedSaving        Float     // Δ término de potencia (peajes+cargos × 365 días)
  excessSaving       Float     // Δ coste de excesos evitados (computeExcessTerm, art. 9.4.b.1)
  annualSaving       Float     // fixedSaving + excessSaving
  recommendChange    Boolean   // true si annualSaving supera el umbral mínimo y hay desvío
  // Restricción de un cambio de potencia al año por distribuidora
  changeAllowed      Boolean   // false si hubo un cambio en los últimos 365 días
  changeBlockedUntil DateTime? // fecha hasta la que no se puede volver a cambiar; null si changeAllowed
  periods            PowerOptimizationPeriod[]
  createdAt          DateTime  @default(now())
  @@unique([supplyId, analysisFrom, analysisTo])  // idempotencia de savePowerOptimization
}

model PowerOptimizationPeriod {
  id             String            @id @default(uuid())
  optimizationId String
  optimization   PowerOptimization @relation(fields: [optimizationId], references: [id])
  period         Int               // 1–6 (power period)
  currentPower   Float             // kW contratados actualmente
  optimalPower   Float             // kW recomendados (tras uplift y restricción monótona)
  p99Power       Float             // kW — percentil 99 de la muestra de potencia del período
  observedMax    Float             // kW — máximo de los máximos mensuales (max_power) del período
  diagnosis      String            // "OK" | "OVERSIZED" | "UNDERSIZED"
  marginPct      Float             // (optimalPower − currentPower) / currentPower × 100 (informativo)
  @@unique([optimizationId, period])
}
```

> **Cambio en `Supply`**: añadir la relación inversa `powerOptimizations PowerOptimization[]`.
> No se modifica ningún otro modelo de M01. El campo `validFrom` de `Contract` ya existe y se
> reutiliza para determinar la fecha del último cambio de potencia (cada cambio genera un nuevo
> snapshot de contrato).

> **Valores oficiales `tepp4-5` (€/kW·día), Anexo II de la Resolución de peajes.** Vigentes desde
> **1-ene-2026** (BOE-A-2025-26348): 2.0TD `P1 0,279426 · P2 0,005316`; 3.0TD `P1 0,171373 ·
> P2 0,090584 · P3 0,028721 · P4 0,021891 · P5 0,006142 · P6 0,006142`. Histórico desde
> **1-abr-2025** (BOE-A-2025-5341): 2.0TD `P1 0,275041 · P2 0,005297`; 3.0TD `P1 0,168944 ·
> P2 0,089294 · P3 0,028322 · P4 0,021656 · P5/P6 0,006126`. 2.0TD solo tiene 2 períodos de potencia.
> En seed/demo se siembran con `validFrom 2020-01-01` para cubrir los períodos de los TC; en
> producción deben versionarse por su `validFrom` real. **Cifras extraídas del BOE vía herramienta
> web; verificar contra el PDF oficial antes de facturar a cliente.** La fórmula y la unidad
> (`FPD = Σ tepp4-5 × (Pdp − Pcp) × n`, €/kW·día, art. 9.4.b.1) quedan confirmadas del texto del BOE.

### 4.3 Esquema InfluxDB

M02 **no define measurements nuevos**. Lee `hourly_consumption` (§3.3) para construir la muestra
de potencia y `max_power` (§3.3) para el diagnóstico. La asignación de período horario→período de
potencia se hace con el mismo calendario tarifario de la ingesta (§3.3).

> En 2.0TD la curva tiene 3 períodos de **energía** (P1–P3) pero solo 2 de **potencia** (P1 punta/llano,
> P2 valle). El resolver agrupa los intervalos de energía en los 2 períodos de potencia antes de
> pasar la muestra al engine. En 3.0TD períodos de energía y potencia coinciden (P1–P6).

### 4.4 Algoritmo de cálculo — paso a paso

El cálculo puro vive en un módulo nuevo **`packages/optimization-engine`** (mismo patrón que
`pricing-engine`: sin I/O, sin Prisma, sin InfluxDB; 100 % testeable con datos sintéticos).
Reutiliza `computePowerTerm()` y `computeExcessTerm()` exportados por `pricing-engine`. El resolver
de `apps/api` carga la curva desde InfluxDB, deriva la muestra de potencia por período y la pasa al engine.

#### Responsabilidad del resolver / data source (construcción de los inputs)

El engine es puro: **todos** los agregados del `OptimizationInput` los construye el resolver (o un
`PowerOptimizationDataSource` inyectable, espejo de `PreInvoiceDataSource` de M01) a partir de
`hourly_consumption` en InfluxDB, leyendo la ventana `[analysisFrom, analysisTo]`. Para cada intervalo
de la curva se deriva la potencia `kW = kwh / horasDelIntervalo` (1 h → ×1; 15 min → ×4) y se etiqueta
con su **período de potencia** (mapeo energía→potencia del calendario de ingesta, §3.3; en 2.0TD los 3
períodos de energía se agrupan en 2 de potencia). Solo se usan puntos con `gap="false"`. A partir de ahí:

| Campo del input | Cómo lo construye el resolver |
|-----------------|-------------------------------|
| `powerSamplesByPeriod[Pi]` | array de todas las potencias derivadas de la ventana, agrupadas por período de potencia |
| `monthlyP99ByPeriod["YYYY-MM"][Pi]` | percentil 99 de las potencias de **ese mes** y período (para sobredimensionamiento) |
| `monthlyMaxByPeriod["YYYY-MM"][Pi]` | máximo mensual por período del measurement `max_power` (`Pdp`) |
| `overContractedRatioByPeriod["YYYY-MM"][Pi]` | nº de intervalos del mes con potencia derivada > `contractedPower[Pi]` ÷ nº total de intervalos del mes en ese período |
| `daysByMonth["YYYY-MM"]` | días de facturación de cada mes de la ventana (`n` de la fórmula de excesos) |
| `granularity` | `'hourly'` o `'quarter'` según la resolución real de la curva en InfluxDB |
| `contractedPower`, `modePowerControl` | del `Contract` vigente; `lastPowerChangeDate` = `Contract.validFrom` más reciente |
| `tollRatesPower`, `chargeRatesPower`, `excessRatesPower` | de `loadRegulatoryRates(..., { requireExcess: isMaximetro })` |

> El histórico mínimo (12 meses) se valida en el resolver **antes** de invocar al engine; si la ventana
> tiene menos meses con datos → `INSUFFICIENT_HISTORY`. Si no hay ningún punto `gap="false"` →
> `NO_CONSUMPTION_DATA`.

#### Interfaz del optimization-engine

```typescript
// ─── Input ────────────────────────────────────────────────────────────────────

interface OptimizationInput {
  tariff: 'T_2_0TD' | 'T_3_0TD';
  granularity: 'hourly' | 'quarter';

  // Potencias contratadas actuales (kW). 2.0TD: { P1, P2 } | 3.0TD: { P1..P6 } (power periods)
  contractedPower: Record<string, number>;

  // Muestra de potencia derivada de la curva (kW), por power period.
  // El resolver la construye: kW = kWh / horasDelIntervalo, agrupado por período.
  powerSamplesByPeriod: Record<string, number[]>;

  // Percentil 99 mensual de la curva, por período y mes (para detección de sobredimensionamiento).
  // Clave externa: "YYYY-MM"; interna: power period → p99 de ese mes.
  monthlyP99ByPeriod: Record<string, Record<string, number>>;

  // Máximos mensuales reales (max_power), por período y mes (Pdp del exceso). Clave: "YYYY-MM".
  // Se usa tanto para el diagnóstico como para computeExcessTerm.
  monthlyMaxByPeriod: Record<string, Record<string, number>>;

  // Días de facturación de cada mes de la ventana (n de la fórmula de excesos). Clave: "YYYY-MM".
  daysByMonth: Record<string, number>;

  // Control de potencia: 'ICP' → sin excesos (2.0TD); 'MAXIMETRO' → aplica computeExcessTerm.
  modePowerControl: 'ICP' | 'MAXIMETRO';

  // Recuento de intervalos del mes con potencia > contratada, por período y mes (infradimensionamiento).
  overContractedRatioByPeriod: Record<string, Record<string, number>>; // ratio 0..1 por "YYYY-MM"

  // Tarifas de potencia (€/kW/día) por período. Origen: TollRate + ChargeRate (POWER).
  tollRatesPower: Record<string, number>;
  chargeRatesPower: Record<string, number>;

  // Término de exceso de potencia tepp4-5 (€/kW·día) por período. Origen: ExcessPowerRate.
  excessRatesPower: Record<string, number>;

  // Parámetros de configuración (con defaults si el resolver no los pasa)
  oversizeFactor?: number;   // default 0.70 — umbral de sobredimensionamiento
  oversizeMonths?: number;   // default 6    — meses consecutivos requeridos
  undersizeRatio?: number;   // default 0.02 — fracción de intervalos en exceso
  minSavingEur?: number;     // default 0    — ahorro mínimo para recommendChange=true

  // Restricción de un cambio/año
  lastPowerChangeDate: string | null; // ISO "YYYY-MM-DD" (Contract.validFrom más reciente)
  analysisTo: string;                  // ISO "YYYY-MM-DD" — fin de la ventana analizada
}

// ─── Output ───────────────────────────────────────────────────────────────────

interface OptimizationResult {
  periods: OptimizationPeriod[];
  fixedSaving: number;        // €/año
  excessSaving: number;       // €/año
  annualSaving: number;       // €/año
  recommendChange: boolean;
  changeAllowed: boolean;
  changeBlockedUntil: string | null; // ISO; null si changeAllowed
  upliftFactor: number;       // 1.05 | 1.00
  sampleCount: number;
}

interface OptimizationPeriod {
  period: number;             // 1–6
  currentPower: number;       // kW
  optimalPower: number;       // kW
  p99Power: number;           // kW
  observedMax: number;        // kW
  diagnosis: 'OK' | 'OVERSIZED' | 'UNDERSIZED';
  marginPct: number;          // %
}
```

#### Paso 1 — Percentil 99 de la muestra y uplift

`uplift = (granularity === 'hourly') ? upliftHourly : upliftQuarter`, con defaults
`upliftHourly = 1.05` y `upliftQuarter = 1.00`.

Para cada power period `Pi` activo según la tarifa (P1–P2 en 2.0TD; P1–P6 en 3.0TD):

```
p99[Pi]        = percentil(99, powerSamplesByPeriod[Pi])
optimalRaw[Pi] = p99[Pi] × uplift
```

> El percentil se calcula por **interpolación lineal** sobre la muestra ordenada (método
> "linear" / R-7, el de `numpy.percentile` por defecto). Los tests fijan el método para
> evitar ambigüedad entre implementaciones.

> **Uplift configurable (calibración).** El coeficiente es **empírico** (compensa el pico perdido
> al derivar potencia de energía horaria), no regulatorio. Es un parámetro de entrada del engine
> (`upliftHourly`/`upliftQuarter`) y el resolver lo lee de las variables de entorno
> `OPT_UPLIFT_HOURLY`/`OPT_UPLIFT_QUARTER` si están definidas (≥ 1), de modo que se recalibra **sin
> recompilar**. Un valor bajo **no** produce recomendaciones falsas: el coste de excesos de la
> potencia óptima se calcula y se **netea** en `excessSaving`/`annualSaving` (Paso 4), y
> `recommendChange` exige ahorro neto positivo. Si en datos reales el `excessSaving` resultara
> negativo de forma recurrente, es la señal documentada para subir el uplift por configuración.

#### Paso 2 — Restricción de monotonía P1 ≤ P2 ≤ … ≤ P6

La normativa exige potencias contratadas **no decrecientes** del período 1 al 6. Se aplica un
máximo acumulado desde P1:

```
optimalPower[P1] = optimalRaw[P1]
optimalPower[Pi] = max(optimalPower[Pi-1], optimalRaw[Pi])   para i = 2..N
```

> Esto puede elevar la potencia de un período "valle" por encima de su propia demanda si un
> período anterior la exige. Es el resultado correcto según la restricción regulatoria, no un
> error de cálculo. En 2.0TD solo se aplica entre P1 y P2.

#### Paso 3 — Diagnóstico por período

Para cada `Pi`:

```
observedMax[Pi] = max sobre los meses de monthlyMaxByPeriod[mes][Pi]
marginPct[Pi]   = (optimalPower[Pi] − currentPower[Pi]) / currentPower[Pi] × 100

// Sobredimensionado: p99 mensual < oversizeFactor × Pc durante oversizeMonths meses consecutivos
mesesSobre = mayor racha de meses consecutivos con monthlyP99ByPeriod[mes][Pi] < oversizeFactor × currentPower[Pi]
oversized  = mesesSobre ≥ oversizeMonths

// Infradimensionado: algún mes con fracción de intervalos en exceso > undersizeRatio
undersized = ∃ mes : overContractedRatioByPeriod[mes][Pi] > undersizeRatio

Si undersized:        diagnosis[Pi] = 'UNDERSIZED'
Si no y oversized:    diagnosis[Pi] = 'OVERSIZED'
En otro caso:         diagnosis[Pi] = 'OK'
```

> `UNDERSIZED` tiene prioridad sobre `OVERSIZED`: un período no puede estar simultáneamente
> infra y sobredimensionado, y el riesgo de penalización por exceso prevalece en el aviso.

#### Paso 4 — Ahorro estimado (reutiliza `computePowerTerm` y `computeExcessTerm`)

**Término de potencia.** `computePowerTerm(power, tollRatesPower, chargeRatesPower, days)` es la
función pura extraída del Paso 1 de §3.4. Se anualiza con **365 días**:

```
powerTermCurrent = computePowerTerm(currentPower, tollRatesPower, chargeRatesPower, 365)
powerTermOptimal = computePowerTerm(optimalPower, tollRatesPower, chargeRatesPower, 365)
fixedSaving      = powerTermCurrent − powerTermOptimal
```

**Término de excesos.** `computeExcessTerm()` aplica la fórmula regulatoria real (art. 9.4.b.1,
tipos 4 y 5). Si `modePowerControl === 'ICP'` el término es 0 (2.0TD con ICP no tiene excesos).
En otro caso, sobre los meses reales de la ventana (no reescalado: `n` ya son los días de cada mes):

```
excessCost(power) = Σ_meses Σ_Pi  excessRatesPower[Pi] × max(0, monthlyMaxByPeriod[mes][Pi] − power[Pi]) × daysByMonth[mes]
excessSaving      = excessCost(currentPower) − excessCost(optimalPower)
```

> `computeExcessTerm` es la **misma** función que usa M01 tras la fase previa de corrección, de
> modo que la línea de excesos de la pre-factura y el ahorro de excesos de M02 son consistentes.
> `max(0, …)` recoge la condición regulatoria "solo períodos en que `Pdp` supere `Pcp`".

```
annualSaving    = fixedSaving + excessSaving
recommendChange = annualSaving > minSavingEur  AND  ∃ Pi : diagnosis[Pi] ≠ 'OK'
```

> Bajar la potencia reduce `fixedSaving` (positivo) pero puede **aumentar** el coste de excesos
> (`excessSaving` negativo). El óptimo `p99 × 1.05` está dimensionado para que los excesos de la
> potencia óptima sean ≈ 0, de modo que `excessSaving` recoge sobre todo las penalizaciones
> **actuales** que se evitarían. `annualSaving` puede ser negativo: en ese caso `recommendChange = false`.

#### Paso 5 — Restricción de un cambio de potencia al año

```
Si lastPowerChangeDate !== null y (analysisTo − lastPowerChangeDate) < 365 días:
  changeAllowed      = false
  changeBlockedUntil = lastPowerChangeDate + 365 días
Si no:
  changeAllowed      = true
  changeBlockedUntil = null
```

> `changeAllowed = false` **no** anula la recomendación: se muestra el óptimo y el ahorro, pero la
> UI advierte de que la distribuidora no permitirá el cambio hasta `changeBlockedUntil`.

#### Notas de precisión y redondeo

- Mismo criterio que §3.4: **sin redondeo intermedio**; solo se redondea a 2 decimales (€) o a la
  precisión de contratación de potencia (kW) **en presentación**. El engine nunca redondea.
- Los tests de importes validan con tolerancia `±0.01 €`; los de potencia con `±0.001 kW`.

### 4.5 Esquema GraphQL

```graphql
type PowerOptimizationPeriod {
  period:       Int!
  currentPower: Float!
  optimalPower: Float!
  p99Power:     Float!
  observedMax:  Float!
  diagnosis:    String!   # "OK" | "OVERSIZED" | "UNDERSIZED"
  marginPct:    Float!
}

type PowerOptimization {
  id:                 ID!
  supplyId:           String!
  tariff:             Tariff!
  analysisFrom:       String!   # ISO 8601 "YYYY-MM-DD"
  analysisTo:         String!
  granularity:        String!   # "hourly" | "quarter"
  upliftFactor:       Float!
  sampleCount:        Int!
  fixedSaving:        Float!
  excessSaving:       Float!
  annualSaving:       Float!
  recommendChange:    Boolean!
  changeAllowed:      Boolean!
  changeBlockedUntil: String     # ISO; null si changeAllowed
  periods:            [PowerOptimizationPeriod!]!
  createdAt:          String!
}

input PowerOptimizationInput {
  cups:         String!
  analysisFrom: String!  # "YYYY-MM-DD"
  analysisTo:   String!  # "YYYY-MM-DD"
}

extend type Query {
  # Calcula sin persistir. Lee la curva de InfluxDB; no llama a DATADIS.
  calculatePowerOptimization(input: PowerOptimizationInput!): PowerOptimization!

  # Recupera una optimización ya guardada.
  powerOptimization(id: ID!): PowerOptimization

  # Lista las optimizaciones de un suministro, ordenadas por analysisTo desc.
  powerOptimizations(supplyId: String!, limit: Int, offset: Int): [PowerOptimization!]!
}

extend type Mutation {
  # Calcula y persiste. Idempotente por (supplyId, analysisFrom, analysisTo).
  savePowerOptimization(input: PowerOptimizationInput!): PowerOptimization!

  deletePowerOptimization(id: ID!): Boolean!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` / `BACKFILL_RUNNING` / `BACKFILL_FAILED` | El histórico aún no está disponible (ver §3.5) |
| `CONTRACT_NOT_FOUND` | No hay contrato vigente del que leer las potencias actuales |
| `INSUFFICIENT_HISTORY` | Menos de 12 meses de curva en la ventana solicitada |
| `NO_CONSUMPTION_DATA` | No hay puntos de `hourly_consumption` utilizables en la ventana |
| `REGULATORY_DATA_MISSING` | Faltan `TollRate`/`ChargeRate` (POWER) o `ExcessPowerRate` para calcular el ahorro |

### 4.6 Casos de test — contrato de implementación

> Los tests del `optimization-engine` son unitarios (sin I/O). Los del resolver son de
> integración con Prisma e InfluxDB mockeados. Nomenclatura `TC-OPT-NNN` (§9.1).

#### TC-OPT-001 — Percentil 99 + uplift + monotonía (3.0TD, hourly) — Unit

`granularity: 'hourly'` → `upliftFactor = 1.05`.

| Período | p99 muestra (kW) | optimalRaw = p99×1.05 | optimalPower (tras monotonía) |
|---------|------------------|-----------------------|-------------------------------|
| P1 | 30 | 31.5  | 31.5 |
| P2 | 32 | 33.6  | 33.6 |
| P3 | 31 | 32.55 | 33.6  *(elevado por P2)* |
| P4 | 35 | 36.75 | 36.75 |
| P5 | 40 | 42.0  | 42.0 |
| P6 | 42 | 44.1  | 44.1 |

Verifica: aplicación del uplift 1.05 y que P3 se eleva a 33.6 por la restricción `optimalPower[Pi] = max(optimalPower[Pi-1], optimalRaw[Pi])`.

#### TC-OPT-002 — 2.0TD con 2 períodos de potencia — Unit

`tariff: T_2_0TD`. La muestra se agrupa en P1 y P2. Verifica que solo se calculan 2 períodos y que se respeta `optimalPower[P1] ≤ optimalPower[P2]`.

#### TC-OPT-003 — Granularidad 15 min → sin uplift — Unit

`granularity: 'quarter'` → `upliftFactor = 1.00`. Con la misma muestra que TC-OPT-001, `optimalRaw[Pi] = p99[Pi]` (sin ×1.05).

#### TC-OPT-004 — Sobredimensionamiento (6 meses consecutivos) — Unit

`currentPower[P1] = 50`. `monthlyP99ByPeriod[P1]` < 35 (= 0.70 × 50) en 6 meses consecutivos → `diagnosis[P1] = 'OVERSIZED'`. Con solo 5 meses consecutivos por debajo → `'OK'`.

#### TC-OPT-005 — Infradimensionamiento (>2 % intervalos en exceso) — Unit

`overContractedRatioByPeriod[P1]` con un mes a `0.03` (> 0.02) → `diagnosis[P1] = 'UNDERSIZED'`. Verifica además que `UNDERSIZED` gana a `OVERSIZED` si ambos se cumplen.

#### TC-OPT-006 — Ahorro por término de potencia (reutiliza computePowerTerm) — Unit

`currentPower = {P1..P6: 40}`, `optimalPower = {31.5, 33.6, 33.6, 36.75, 42, 44.1}`, tarifa de potencia sintética `0.08 €/kW/día` en todos los períodos, 365 días, sin excesos:

```
powerTermCurrent = 6 × 40 × 0.08 × 365 = 7008.00 €
powerTermOptimal = (31.5+33.6+33.6+36.75+42+44.1) × 0.08 × 365
                 = 221.55 × 0.08 × 365 = 6469.26 €
fixedSaving      = 7008.00 − 6469.26 = 538.74 €/año
```

Verifica que M02 invoca exactamente la `computePowerTerm` del `pricing-engine` (no una copia).

#### TC-OPT-007 — Ahorro incluye excesos evitados (fórmula real tipos 4/5) — Unit

`modePowerControl: 'MAXIMETRO'`, `tepp4-5 = 0.05 €/kW·día`. Un mes de 30 días con `currentPower[P1] = 30` y `monthlyMaxByPeriod['2025-07'][P1] = 45`; `optimalPower[P1] = 47.25` (dimensionada para no tener excesos):

```
excessCost(current) = 0.05 × max(0, 45 − 30) × 30 = 0.05 × 15 × 30 = 22.50 €
excessCost(optimal) = 0.05 × max(0, 45 − 47.25) × 30 = 0.05 × 0 × 30 = 0.00 €
excessSaving        = 22.50 − 0.00 = 22.50 €
```

Verifica que `computeExcessTerm` aplica `Σ tepp4-5 × (Pdp − Pcp) × n` (sin √, sin ×2) y que `annualSaving = fixedSaving + excessSaving`.

#### TC-OPT-007b — 2.0TD con ICP → término de excesos = 0 — Unit

`tariff: T_2_0TD`, `modePowerControl: 'ICP'`. Aunque `monthlyMaxByPeriod` contenga valores > Pc, `excessCost(power) = 0` para cualquier potencia → `excessSaving = 0`.

#### TC-OPT-008 — annualSaving negativo → recommendChange false — Unit

Caso donde bajar la potencia ahorra fijo pero dispara excesos (`excessSaving` muy negativo) y `annualSaving < 0` → `recommendChange = false` aunque haya desvío de potencia.

#### TC-OPT-009 — Restricción de un cambio/año — Unit

`lastPowerChangeDate = analysisTo − 200 días` → `changeAllowed = false`, `changeBlockedUntil = lastPowerChangeDate + 365 días`. Con `lastPowerChangeDate = analysisTo − 400 días` → `changeAllowed = true`, `changeBlockedUntil = null`.

#### TC-OPT-010 — Histórico insuficiente → INSUFFICIENT_HISTORY — Integration

Ventana con < 12 meses de `hourly_consumption` → el resolver eleva `INSUFFICIENT_HISTORY` y no invoca al engine.

#### TC-OPT-011 — Sin contrato vigente → CONTRACT_NOT_FOUND — Integration

No hay `Contract` para el CUPS en la fecha → `CONTRACT_NOT_FOUND`.

#### TC-OPT-012 — Faltan maestros de potencia → REGULATORY_DATA_MISSING — Integration

Faltan `TollRate`/`ChargeRate` (POWER) o `ExcessPowerRate` para algún período → `REGULATORY_DATA_MISSING`.

#### TC-OPT-013 — backfillStatus RUNNING → BACKFILL_RUNNING — Integration

Suministro con `backfillStatus = RUNNING` → `BACKFILL_RUNNING` (mismo contrato que §3.7).

#### TC-OPT-014 — savePowerOptimization idempotente — Integration

Dos llamadas con la misma `(supplyId, analysisFrom, analysisTo)` devuelven el mismo registro (no duplican), por el `@@unique`.

#### TC-OPT-015 — CUPS inexistente → SUPPLY_NOT_FOUND — Integration

El CUPS no existe en PostgreSQL → `SUPPLY_NOT_FOUND`.

#### TC-OPT-016 — sin curva utilizable → NO_CONSUMPTION_DATA — Integration

No hay puntos `gap="false"` en la ventana (`hasUsableData=false`) → `NO_CONSUMPTION_DATA`.

#### TC-OPT-017 — backfill no listo → BACKFILL_PENDING / BACKFILL_FAILED — Integration

`backfillStatus = PENDING` → `BACKFILL_PENDING`; `= FAILED` → `BACKFILL_FAILED` (mismo contrato que §3.7).

#### TC-OPT-018 — autorización — Integration

`USUARIO` sobre `savePowerOptimization` → `FORBIDDEN` (no persiste). `ADMIN` de otro cliente sobre
`calculatePowerOptimization` de un supply ajeno → `FORBIDDEN` (mismas reglas que §2.2 / TC-AUTH).

#### TC-OPT-019 — powerOptimization(id) — Integration

Recupera el registro persistido con sus `periods`. Id inexistente → `null` (sin error). `ADMIN` de
otro cliente → `FORBIDDEN`.

#### TC-OPT-020 — powerOptimizations(list) — Integration

Lista del suministro; el resolver delega orden (`analysisTo desc`) y paginación (`take`/`skip`) a
Prisma. Supply inexistente → `SUPPLY_NOT_FOUND`.

#### TC-OPT-021 — deletePowerOptimization — Integration

Borra y devuelve `true` (elimina antes los `periods`). Id inexistente → `false`. `USUARIO` →
`FORBIDDEN` (no borra).

### 4.7 Front (apps/web) — no normativo

> El front **no estaba en el alcance original de M02** (el §4 es backend). Esta subsección documenta
> la pantalla añadida para enseñar el módulo en el modo demo; las decisiones de UI son orientativas,
> no contrato de implementación.

- **Topbar compartida** (`app/shared/topbar.component.ts`): marca, navegación **Pre-factura /
  Optimización** (resalta la ruta activa) y título de sección grande vía `@Input() section`. La
  usan ambas pantallas; sustituye a la cabecera inline que tenía M01.
- **Ruta** `/optimizacion` (protegida por `authGuard`) → `OptimizationComponent`
  (`app/optimization/`). Reutiliza `GraphqlService` y llama a `calculatePowerOptimization` (no persiste).
- **Layout veredicto-primero**: el titular responde a la decisión del usuario —
  *"Conviene reducir/subir/reajustar la potencia"* (con ahorro anual neto) · *"Potencia bien
  dimensionada"* · *"Potencia insuficiente (riesgo de penalización)"*. Debajo, la **acción** (potencia
  a solicitar por período + restricción de 1 cambio/año) y un desglose neto compacto; la tabla por
  período queda como evidencia.
- **Alcance**: la pantalla decide sobre **potencia contratada** con la distribuidora actual. **No**
  compara comercializadoras ni planes (sería un módulo aparte, fuera de M01–M06).
- **Etiquetado de excesos**: el `excessSaving` puede ser negativo (bajar potencia acerca la óptima al
  máximo demandado y puede generar excesos); en UI se etiqueta como *"Penaliz. por excesos"* cuando es
  negativo y el titular usa siempre el **neto** (`annualSaving`).
- **Curva demo**: `demo/demoOptimizationDataSource.ts` genera ≥12 meses de curva horaria determinista;
  el `max_power` se fija coherente con la curva y un período (P6 en el 3.0TD sembrado) queda
  infradimensionado a propósito para ejercitar los tres diagnósticos. Valores ilustrativos.

---

## 5. M03 — Alertas y detección de anomalías

Audita de forma **retrospectiva** la curva de consumo ya ingestada y genera **alertas** de cuatro
tipos: anomalías estadísticas (`ZSCORE`), consumo en horas de inactividad declarada (`PHANTOM`),
proximidad al límite de potencia contratada (`LIMIT`) y datos de baja calidad (`ESTIMATED`). A
diferencia de M01/M02 (que **calculan bajo demanda**), una alerta es un **objeto con estado** que se
persiste, se acumula y el usuario gestiona (marca como vista o descarta). La detección la realiza un
**job programado** en `apps/worker`; el cálculo puro vive en un módulo nuevo `packages/alerts-engine`
(sin I/O). **No es tiempo real**: opera sobre datos D-1/D-2 (los que ya llegaron de DATADIS).

### 5.0 Decisiones de diseño (premisas de este módulo)

> **Latencia D-1/D-2 — auditoría, no monitorización**. DATADIS publica la curva con uno o dos días de
> retraso (la ingesta diaria de §1.5 solicita **D-2**). M03 **no** puede avisar "en directo": detecta
> anomalías sobre el último día cerrado disponible. La UI debe comunicarlo explícitamente para no
> generar la expectativa de tiempo real.

> **Ruptura deliberada del patrón "calcular sin persistir" de M01/M02**. M01 y M02 son consultas que
> recalculan en cada invocación y dejaron la persistencia aparcada a propósito. Para alertas la
> persistencia **no es opcional**: sin estado no se puede distinguir una alerta nueva de una ya vista,
> ni evitar volver a notificar lo mismo cada día. Por eso M03 introduce un **job que persiste** filas
> `Alert` y resolvers que las **consultan y gestionan** (no las recalculan en cada lectura).

> **Sin notificación automática por correo (v1)**. Las alertas se exponen **in-app** (lista + badges).
> El envío de notificaciones por email/push queda **fuera de alcance** en v1; si se añade, será como
> **borrador** que un humano revisa antes de enviar, nunca un envío automático.

1. **`ZSCORE` por slot semanal-horario**. Para cada hora del día evaluado se compara su consumo contra
   la distribución del **mismo slot** `(día de la semana, hora)` en las **13 semanas** previas (≈ 13
   muestras, una por semana). Esto absorbe la estacionalidad semanal (un lunes a las 9:00 se compara
   con lunes a las 9:00, no con domingos). Es la lectura literal de "z-score ventana 13 semanas por
   slot horario" del brief. **Limitación asumida**: 13 muestras es una base pequeña; se usa desviación
   típica **muestral** (n−1) y se exige un mínimo de historia (`INSUFFICIENT_HISTORY` si < 13 semanas).

2. **Sensibilidad → umbral de z**. La configuración expone tres niveles que mapean a un umbral de
   z-score (valor absoluto): `conservador → 3.5`, `equilibrado → 3.0` (default), `agresivo → 2.5`.
   Un nivel más agresivo genera más alertas (y más ruido). Es un parámetro de entrada del engine,
   recalibrable sin tocar la fórmula.

3. **`LIMIT` sobre potencia derivada de energía horaria**. Igual que M02 (§4.0 punto 1), la potencia
   instantánea no está disponible; se deriva `kW = kWh / horasDelIntervalo`. Una alerta `LIMIT` salta
   cuando esa potencia derivada alcanza `limitThresholdPct` (default **0.95**) de la potencia
   contratada del período. **Limitación asumida**: subestima el pico real, por lo que `LIMIT` es
   conservadora (puede no avisar de picos sub-horarios). No sustituye a la facturación de excesos de
   M01, que usa `max_power` real.

4. **`PHANTOM` sobre franjas declaradas por el cliente**. No hay forma de inferir "inactividad" de los
   datos; el cliente declara sus franjas (p. ej. noches y findes) en la configuración del suministro.
   Una alerta `PHANTOM` salta si hay consumo por encima de un umbral (`phantomThresholdKwh`) dentro de
   una franja declarada como inactiva.

5. **`ESTIMATED` es informativa (calidad de dato)**. Marca los intervalos del día evaluado con
   `estimated="true"` (DATADIS devolvió `obtainMethod="Estimada"`). No es una anomalía de consumo sino
   un aviso de fiabilidad; severidad `INFO`. Reutiliza el mismo tag que M01 (§3.3).

### 5.0bis Prerrequisitos de implementación

- **Nuevo paquete `packages/alerts-engine`**: función pura `detectAlerts(input)` y utilidades
  estadísticas (`mean`, `sampleStd`, `zscore`). Mismo patrón que `optimization-engine`: sin Prisma,
  sin InfluxDB, 100 % testeable con datos sintéticos. No reutiliza el `pricing-engine` (la detección
  no comparte fórmula con el cálculo de factura).
- **Nuevo job en `apps/worker`**: función `evaluateAlerts(deps)` añadida a `scheduler.ts`, envuelta en
  `safe()` y programada con `node-cron` **después** de la ingesta diaria de consumo (06:00) —
  propuesta `0 7 * * *`. Recorre los suministros con `AlertConfig` activa, construye los inputs desde
  InfluxDB y persiste las alertas nuevas.
- **Nuevos modelos Prisma** `AlertConfig` y `Alert` + relaciones inversas en `Supply`. Como en M01/M02,
  **no hay migración aplicada** (el repo nunca ha corrido contra Postgres real); se añaden a
  `schema.prisma` y se aplican con `prisma migrate dev` cuando exista BD. En tests, cliente mockeado.
- **Data source de serie horaria** (≥ 13 semanas): `AlertDataSource` inyectable (espejo de
  `PreInvoiceDataSource`/`PowerOptimizationDataSource`), real = Flux contra InfluxDB, demo =
  generador determinista. Se inyecta vía `runtime.ts` (`setAlertDataSource`/`getAlertDataSource`).
- **Patrón de tests**: Vitest; mock de Prisma con `vi.hoisted` (no `vitest-mock-extended`, ver §9.3).

### 5.1 Fuentes de datos

| Fuente | Endpoint / origen | Dato obtenido | Uso en M03 |
|--------|-------------------|---------------|------------|
| InfluxDB | measurement `hourly_consumption` (`kwh`, `gap="false"`) | Curva horaria del día evaluado + 13 semanas previas | `ZSCORE`, `PHANTOM`, `LIMIT` |
| InfluxDB | measurement `hourly_consumption` (tag `estimated`) | Marca de dato estimado por DATADIS | `ESTIMATED` |
| PostgreSQL | `Contract` (último vigente) | Potencias contratadas por período | `LIMIT` (umbral = `limitThresholdPct` × Pc) |
| PostgreSQL | `AlertConfig` (por suministro) | Sensibilidad, umbrales, franjas de inactividad, tipos activos | Parámetros de detección |

> **Sin ingesta nueva**: M03 consume datos que ya carga M01 (`hourly_consumption`) mediante el backfill
> de onboarding (2 años) y el job diario (§1.5). No añade measurements, no llama a DATADIS/ESIOS durante
> la evaluación.
>
> **Historia mínima**: el `ZSCORE` exige al menos **13 semanas** (≈ 91 días) de curva para tener una
> muestra por slot. Si la ventana de referencia tiene menos → `INSUFFICIENT_HISTORY`. `PHANTOM`,
> `LIMIT` y `ESTIMATED` solo necesitan el día evaluado, pero la evaluación se aborta igual si falta
> historia para el `ZSCORE` cuando ese tipo está activo.

### 5.2 Modelos Prisma

```prisma
// ─── Configuración de alertas por suministro (M03) ───────────────────────────

enum AlertSensitivity {
  CONSERVADOR   // z-threshold 3.5
  EQUILIBRADO   // z-threshold 3.0 (default)
  AGRESIVO      // z-threshold 2.5
}

enum AlertType   { ZSCORE  PHANTOM  LIMIT  ESTIMATED }
enum AlertStatus { NEW  ACKNOWLEDGED  DISMISSED }
enum AlertSeverity { INFO  WARNING  CRITICAL }

model AlertConfig {
  id                 String           @id @default(uuid())
  supplyId           String           @unique          // 1 config por suministro
  supply             Supply           @relation(fields: [supplyId], references: [id])
  enabled            Boolean          @default(true)
  sensitivity        AlertSensitivity @default(EQUILIBRADO)
  enabledTypes       String           // CSV de AlertType activos, p.ej. "ZSCORE,PHANTOM,LIMIT,ESTIMATED"
  limitThresholdPct  Float            @default(0.95)    // fracción de la potencia contratada (LIMIT)
  phantomThresholdKwh Float           @default(0.0)     // consumo mínimo en franja inactiva para PHANTOM
  inactivityWindows  Json             // [{ "days":[0..6], "from":"HH:MM", "to":"HH:MM" }] hora local Madrid
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
}

// ─── Alerta detectada (M03) ──────────────────────────────────────────────────

model Alert {
  id             String        @id @default(uuid())
  supplyId       String
  supply         Supply        @relation(fields: [supplyId], references: [id])
  type           AlertType
  severity       AlertSeverity
  status         AlertStatus   @default(NEW)
  period         Int           // 1–6 (período del intervalo); 0 si no aplica
  windowStart    DateTime      // inicio del intervalo anómalo (UTC)
  windowEnd      DateTime      // fin del intervalo anómalo (UTC)
  observedValue  Float         // valor observado (kWh, kW o z-score según tipo)
  expectedValue  Float?        // referencia esperada (media del slot, umbral, Pc); null si no aplica
  deviation      Float?        // desvío (z-score o ratio sobre el umbral); null si no aplica
  message        String        // descripción legible generada por el engine
  detectedAt     DateTime      @default(now())
  acknowledgedBy String?       // userId que la gestionó
  acknowledgedAt DateTime?
  @@unique([supplyId, type, windowStart, period])  // idempotencia del job (no re-crea la misma)
}
```

> **Cambios en `Supply`**: añadir las relaciones inversas `alerts Alert[]` y `alertConfig AlertConfig?`.
> No se modifica ningún otro modelo de M01/M02.

> **Idempotencia y estado**: el `@@unique([supplyId, type, windowStart, period])` garantiza que una
> re-ejecución del job sobre el mismo día **no duplica** alertas. Si la alerta ya existe y está
> `ACKNOWLEDGED`/`DISMISSED`, el job la **respeta** (no la revierte a `NEW`). `enabledTypes` y las
> franjas se guardan como texto/JSON por portabilidad (SQLite en demo, Postgres en prod).

### 5.3 Esquema InfluxDB

M03 **no define measurements nuevos**. Lee `hourly_consumption` (§3.3): el `kwh` con `gap="false"`
para `ZSCORE`/`PHANTOM`/`LIMIT`, y el tag `estimated` para `ESTIMATED`. La asignación de `period` y la
hora local (para casar las franjas de inactividad declaradas en hora de Madrid) usan el mismo
calendario tarifario de la ingesta (§3.3).

> Para `LIMIT` se reutiliza la derivación de potencia de M02 (`kW = kWh / horasDelIntervalo`; ×4 en
> 15 min). `max_power` (§3.3) **no** se usa en M03: la alerta es preventiva sobre la curva, no sobre el
> máximo facturado.

### 5.4 Algoritmo de detección — paso a paso

El cálculo puro vive en `packages/alerts-engine` (`detectAlerts`): sin I/O, sin Prisma, sin InfluxDB.
El job (o el resolver de evaluación manual) carga la curva desde InfluxDB mediante un
`AlertDataSource` inyectable, construye el input y persiste las alertas resultantes.

#### Responsabilidad del job / data source (construcción de los inputs)

Para evaluar el día objetivo `D` (por defecto **D-2**, el último día cerrado en InfluxDB), el job
construye desde InfluxDB:

| Campo del input | Cómo lo construye el job / data source |
|-----------------|----------------------------------------|
| `targetDay[]` | intervalos `(tsLocal, period, kwh, estimated)` del día `D` (`gap="false"` salvo para detectar `ESTIMATED`) |
| `referenceBySlot["DOW-HH"]` | array de `kwh` del mismo slot `(día de la semana, hora)` en las 13 semanas previas a `D` (`gap="false"`) |
| `contractedPower` | potencias por período del `Contract` vigente (para `LIMIT`) |
| `config` | `sensitivity`, `enabledTypes`, `limitThresholdPct`, `phantomThresholdKwh`, `inactivityWindows` de `AlertConfig` |
| `intervalHours` | 1 ó 0.25 según la resolución real de la curva (para derivar potencia en `LIMIT`) |

> La historia mínima (13 semanas) se valida **antes** de invocar al engine si `ZSCORE` está activo; si
> falta → `INSUFFICIENT_HISTORY`. Si no hay ningún punto `gap="false"` del día objetivo →
> `NO_CONSUMPTION_DATA`. Si falta `Contract` vigente y `LIMIT` está activo → `CONTRACT_NOT_FOUND`.

#### Interfaz del alerts-engine

```typescript
// ─── Input ──────────────────────────────────────────────────────────────────

interface AlertInterval {
  ts: string;        // ISO UTC, inicio del intervalo
  localHour: number; // 0–23 hora local Madrid (para franjas y slot)
  weekday: number;   // 0–6 (0 = domingo) hora local
  period: number;    // 1–6 (período tarifario del intervalo)
  kwh: number;
  estimated: boolean; // DATADIS devolvió obtainMethod="Estimada" → alimenta ESTIMATED
  gap: boolean;      // estimado o imputado (no facturable); ZSCORE/PHANTOM/LIMIT lo ignoran
}

interface InactivityWindow { days: number[]; from: string; to: string; } // "HH:MM" hora local

interface AlertDetectionInput {
  targetDay: AlertInterval[];                       // intervalos del día evaluado
  referenceBySlot: Record<string, number[]>;        // "DOW-HH" → kWh de las 13 semanas previas
  contractedPower: Record<string, number>;          // por período (kW)
  intervalHours: number;                            // 1 | 0.25
  config: {
    enabledTypes: ('ZSCORE'|'PHANTOM'|'LIMIT'|'ESTIMATED')[];
    sensitivity: 'CONSERVADOR'|'EQUILIBRADO'|'AGRESIVO';
    limitThresholdPct: number;                      // default 0.95
    phantomThresholdKwh: number;                    // default 0
    inactivityWindows: InactivityWindow[];
  };
}

// ─── Output ─────────────────────────────────────────────────────────────────

interface DetectedAlert {
  type: 'ZSCORE'|'PHANTOM'|'LIMIT'|'ESTIMATED';
  severity: 'INFO'|'WARNING'|'CRITICAL';
  period: number;            // 1–6; 0 si no aplica
  windowStart: string;       // ISO UTC
  windowEnd: string;         // ISO UTC
  observedValue: number;
  expectedValue: number | null;
  deviation: number | null;  // z-score o ratio sobre umbral
  message: string;
}

function detectAlerts(input: AlertDetectionInput): DetectedAlert[];
```

#### Paso 1 — `ZSCORE` (anomalía estadística por slot)

`zThreshold = { CONSERVADOR: 3.5, EQUILIBRADO: 3.0, AGRESIVO: 2.5 }[sensitivity]`.

Para cada intervalo del día objetivo con clave de slot `key = "${weekday}-${localHour}"`:

```
ref = referenceBySlot[key]              // ≈ 13 valores (uno por semana)
μ   = mean(ref)
σ   = sampleStd(ref)                    // desviación típica muestral (n−1)
Si σ === 0:  no se evalúa (sin variabilidad → sin anomalía)   // evita 0/0
Si no:       z = (kwh − μ) / σ
             Si |z| ≥ zThreshold → alerta ZSCORE
```

- `observedValue = kwh`, `expectedValue = μ`, `deviation = z`.
- `severity`: `WARNING` si `|z| < zThreshold + 1.5`, `CRITICAL` si `|z| ≥ zThreshold + 1.5`.

> Solo se eleva la alerta para desviaciones **al alza** (`z ≥ +zThreshold`, picos) y a la baja
> (`z ≤ −zThreshold`, caídas atípicas que pueden indicar parada no planificada). Ambas se marcan; el
> `message` distingue "consumo anómalamente alto/bajo".

#### Paso 2 — `PHANTOM` (consumo en inactividad declarada)

Para cada intervalo cuyo `(weekday, localHour)` cae dentro de alguna `inactivityWindow`:

```
Si kwh > phantomThresholdKwh → alerta PHANTOM
```

- `observedValue = kwh`, `expectedValue = phantomThresholdKwh`, `deviation = kwh − phantomThresholdKwh`.
- `severity`: `WARNING` (consumo fantasma sostenido en franja declarada inactiva). Franjas que cruzan
  medianoche (`from > to`, p. ej. 22:00→06:00) se interpretan como `[from, 24:00) ∪ [00:00, to)`.

#### Paso 3 — `LIMIT` (proximidad al límite contratado)

```
kw        = kwh / intervalHours                       // potencia derivada del intervalo
limit[Pi] = limitThresholdPct × contractedPower[Pi]
Si kw ≥ limit[period] → alerta LIMIT
```

- `observedValue = kw`, `expectedValue = contractedPower[period]`, `deviation = kw / contractedPower[period]`.
- `severity`: `WARNING` si `kw < contractedPower[period]`, `CRITICAL` si `kw ≥ contractedPower[period]`
  (ya en o por encima de lo contratado → riesgo de exceso facturable).

#### Paso 4 — `ESTIMATED` (calidad de dato)

```
Para cada intervalo del día objetivo con estimated === true → alerta ESTIMATED (severity INFO)
```

- `observedValue = kwh`, `expectedValue = null`, `deviation = null`. Es un aviso de fiabilidad, no de
  consumo. Solo se emite si `ESTIMATED ∈ enabledTypes`.

#### Paso 5 — Persistencia idempotente (responsabilidad del job, no del engine)

El engine devuelve **candidatas**; el job las persiste respetando el estado existente:

```
Para cada candidata c con clave k = (supplyId, c.type, c.windowStart, c.period):
  existing = Alert.findUnique(k)
  Si no existe:                  create(c, status = NEW)
  Si existe y status = NEW:      update campos derivados (severity, valores) — sigue NEW
  Si existe y status ∈ {ACKNOWLEDGED, DISMISSED}:  no tocar (respeta la gestión del usuario)
```

> Una alerta gestionada no "revive" si el job vuelve a verla el mismo día. Alertas de días distintos
> tienen `windowStart` distinto → son entradas distintas (el usuario ve la recurrencia).

#### Notas de precisión y redondeo

- Mismo criterio que §3.4 y §4.4: **sin redondeo intermedio**; el engine nunca redondea. Media,
  desviación y z-score se calculan en doble precisión; el redondeo a 2 decimales es solo de presentación.
- Los tests de z-score validan con tolerancia `±0.001`; los de consumo/potencia con `±0.001`.

### 5.5 Esquema GraphQL

```graphql
type Alert {
  id:            ID!
  supplyId:      String!
  type:          String!   # "ZSCORE" | "PHANTOM" | "LIMIT" | "ESTIMATED"
  severity:      String!   # "INFO" | "WARNING" | "CRITICAL"
  status:        String!   # "NEW" | "ACKNOWLEDGED" | "DISMISSED"
  period:        Int!
  windowStart:   String!   # ISO 8601 UTC
  windowEnd:     String!
  observedValue: Float!
  expectedValue: Float
  deviation:     Float
  message:       String!
  detectedAt:    String!
  acknowledgedBy: String
  acknowledgedAt: String
}

type AlertConfig {
  id:                  ID!
  supplyId:            String!
  enabled:             Boolean!
  sensitivity:         String!   # "CONSERVADOR" | "EQUILIBRADO" | "AGRESIVO"
  enabledTypes:        [String!]!
  limitThresholdPct:   Float!
  phantomThresholdKwh: Float!
  inactivityWindows:   [InactivityWindow!]!
  updatedAt:           String!
}

type InactivityWindow { days: [Int!]!  from: String!  to: String! }

input InactivityWindowInput { days: [Int!]!  from: String!  to: String! }

input AlertConfigInput {
  cups:                String!
  enabled:             Boolean
  sensitivity:         String     # default "EQUILIBRADO"
  enabledTypes:        [String!]
  limitThresholdPct:   Float      # default 0.95
  phantomThresholdKwh: Float      # default 0
  inactivityWindows:   [InactivityWindowInput!]
}

input EvaluateAlertsInput {
  cups: String!
  day:  String   # "YYYY-MM-DD"; default = último día cerrado (D-2)
}

extend type Query {
  # Lista las alertas de un suministro (filtrables), ordenadas por windowStart desc.
  alerts(supplyId: String!, status: String, type: String, limit: Int, offset: Int): [Alert!]!
  alert(id: ID!): Alert
  alertConfig(supplyId: String!): AlertConfig
}

extend type Mutation {
  # Crea o actualiza la configuración del suministro (idempotente por supplyId).
  saveAlertConfig(input: AlertConfigInput!): AlertConfig!

  # Disparo manual de la evaluación (útil en demo sin cron). Persiste y devuelve las alertas.
  evaluateAlerts(input: EvaluateAlertsInput!): [Alert!]!

  acknowledgeAlert(id: ID!): Alert!
  dismissAlert(id: ID!): Alert!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` / `BACKFILL_RUNNING` / `BACKFILL_FAILED` | El histórico aún no está disponible (§3.5) |
| `ALERT_CONFIG_NOT_FOUND` | Se solicita evaluar un suministro sin `AlertConfig` |
| `CONTRACT_NOT_FOUND` | `LIMIT` activo y no hay contrato vigente del que leer las potencias |
| `INSUFFICIENT_HISTORY` | `ZSCORE` activo y menos de 13 semanas de curva de referencia |
| `NO_CONSUMPTION_DATA` | No hay puntos `gap="false"` del día evaluado |
| `ALERT_NOT_FOUND` | `acknowledgeAlert`/`dismissAlert` sobre un id inexistente |

> **Autorización** (§2.2): ver/listar (`alerts`, `alert`, `alertConfig`) → `assertSupplyAccess`
> (DOMINION todo; ADMIN su cliente; GESTOR/USUARIO su suministro). Escribir (`saveAlertConfig`,
> `evaluateAlerts`, `acknowledgeAlert`, `dismissAlert`) → rol de escritura (DOMINION/ADMIN/GESTOR);
> `USUARIO` es **solo lectura** (mismo criterio que `savePreInvoice`/`savePowerOptimization`).

### 5.6 Casos de test — contrato de implementación

> Los tests del `alerts-engine` son unitarios (sin I/O). Los del resolver y el job son de integración
> con Prisma e InfluxDB mockeados. Nomenclatura `TC-ALT-NNN` (§9.1).

#### TC-ALT-001 — ZSCORE dispara con z ≥ umbral (equilibrado) — Unit

Slot con `ref = [10,10,11,9,10,10,11,9,10,10,11,9,10]` (μ=10, σ≈0.7) y `kwh = 13` → `z ≈ 4.2 ≥ 3.0`
→ alerta `ZSCORE`, `deviation ≈ 4.2`. Como `|z| < umbral + 1.5 (= 4.5)`, severidad `WARNING`. Verifica
μ, σ muestral (n−1) y el umbral 3.0.

#### TC-ALT-002 — Sensibilidad cambia el umbral — Unit

Mismo dato con `z = 2.8`: `agresivo` (2.5) → dispara; `equilibrado` (3.0) y `conservador` (3.5) → no.

#### TC-ALT-003 — σ = 0 no produce falso positivo — Unit

`ref = [10,10,…,10]` (consumo constante) y `kwh = 25` → `σ = 0` → **no** se evalúa (sin división por
cero, sin alerta). Confirma el guard del Paso 1.

#### TC-ALT-004 — PHANTOM en franja de inactividad — Unit

`inactivityWindows = [{days:[0..6], from:"22:00", to:"06:00"}]`, intervalo a las 03:00 local con
`kwh = 4 > phantomThresholdKwh (1)` → alerta `PHANTOM`. Verifica el manejo de la franja que cruza
medianoche.

#### TC-ALT-005 — Consumo en franja activa no genera PHANTOM — Unit

Mismo `kwh = 4` a las 12:00 (fuera de franja inactiva) → sin alerta `PHANTOM`.

#### TC-ALT-006 — LIMIT al alcanzar 95 % de la potencia — Unit

`contractedPower[P1] = 10 kW`, `intervalHours = 1`. `kwh = 9.6` → `kw = 9.6 ≥ 9.5` → alerta `LIMIT`
(`WARNING`). `kwh = 10.2` → `kw ≥ 10` → `CRITICAL`. `kwh = 9.0` → sin alerta.

#### TC-ALT-007 — LIMIT en 15 min deriva ×4 — Unit

`intervalHours = 0.25`, `kwh = 2.5` → `kw = 10`. Verifica la derivación de potencia cuartohoraria.

#### TC-ALT-008 — ESTIMATED marca intervalos estimados — Unit

Intervalo con `estimated = true` → alerta `ESTIMATED` (`INFO`, `expectedValue = null`). Con
`estimated = false` → sin alerta.

#### TC-ALT-009 — enabledTypes desactiva un tipo — Unit

Con `enabledTypes = ['LIMIT']`, datos que dispararían `ZSCORE`/`PHANTOM`/`ESTIMATED` no generan nada;
solo se evalúa `LIMIT`.

#### TC-ALT-010 — Histórico insuficiente → INSUFFICIENT_HISTORY — Integration

`ZSCORE` activo y < 13 semanas de referencia → el resolver/job eleva `INSUFFICIENT_HISTORY` y no
invoca al engine.

#### TC-ALT-011 — saveAlertConfig idempotente por suministro — Integration

Dos llamadas con el mismo `cups` actualizan la **misma** `AlertConfig` (no duplican), por el
`@unique(supplyId)`. La segunda refleja los nuevos valores.

#### TC-ALT-012 — acknowledgeAlert cambia el estado — Integration

`NEW → ACKNOWLEDGED`, fija `acknowledgedBy`/`acknowledgedAt`. Id inexistente → `ALERT_NOT_FOUND`.

#### TC-ALT-013 — dismissAlert descarta — Integration

`NEW → DISMISSED`. Una alerta `DISMISSED` no reaparece como `NEW` al reevaluar el mismo día (ver
TC-ALT-018).

#### TC-ALT-014 — alerts(list) con filtros y paginación — Integration

Filtra por `status`/`type`; orden `windowStart desc`; `limit`/`offset` delegados a Prisma. Supply
inexistente → `SUPPLY_NOT_FOUND`.

#### TC-ALT-015 — alert(id) inexistente → null — Integration

Id que no existe → `null` (sin error). `ADMIN` de otro cliente → `FORBIDDEN`.

#### TC-ALT-016 — Autorización — Integration

`USUARIO` sobre `saveAlertConfig`/`acknowledgeAlert`/`dismissAlert`/`evaluateAlerts` → `FORBIDDEN`.
`ADMIN` de otro cliente sobre `alerts` de un supply ajeno → `FORBIDDEN` (reglas de §2.2).

#### TC-ALT-017 — evaluateAlerts manual persiste alertas — Integration

Día con un pico → `evaluateAlerts` devuelve y persiste las alertas (`status = NEW`). Sin `AlertConfig`
→ `ALERT_CONFIG_NOT_FOUND`.

#### TC-ALT-018 — Idempotencia del job: no revive gestionadas — Integration

Tras marcar una alerta `ACKNOWLEDGED`, reevaluar el mismo día **no** crea un duplicado ni la revierte a
`NEW` (por `@@unique` + lógica del Paso 5).

#### TC-ALT-019 — Backfill no listo → BACKFILL_* — Integration

`backfillStatus = PENDING/RUNNING/FAILED` → `BACKFILL_PENDING`/`BACKFILL_RUNNING`/`BACKFILL_FAILED`
(mismo contrato que §3.7 / §4.6).

#### TC-ALT-020 — Sin curva del día → NO_CONSUMPTION_DATA — Integration

No hay puntos `gap="false"` del día evaluado → `NO_CONSUMPTION_DATA`.

#### TC-ALT-021 — LIMIT sin contrato → CONTRACT_NOT_FOUND — Integration

`LIMIT` activo y sin `Contract` vigente para el CUPS → `CONTRACT_NOT_FOUND`.

### 5.7 Front (apps/web) — no normativo

> Como en M02 (§4.7), el front no es contrato de implementación; documenta la pantalla implementada
> para enseñar el módulo en modo demo. Se priorizó la **claridad sobre la exhaustividad**: se exponen
> solo las opciones necesarias y en lenguaje llano.

- **Topbar**: nueva entrada **Alertas** junto a Pre-factura / Optimización (`shared/topbar.component.ts`).
- **Ruta** `/alertas` (protegida por `authGuard`) → `AlertsComponent`. Reutiliza `GraphqlService`.
- **Dos tarjetas** únicamente:
  1. **Suministro + ajustes** (con una **leyenda lateral** "¿qué es cada alarma?" en lenguaje llano:
     Anomalía / Consumo fantasma / Cerca del límite / Dato estimado). Contiene: selector de suministro,
     *sensibilidad* (Pocas / Equilibrado / Muchas → CONSERVADOR/EQUILIBRADO/AGRESIVO), *interruptores de
     tipo* (qué alarmas activar) y el botón **Analizar último día**.
  2. **Alarmas encontradas**: lista con badge de **tipo** (la franja lateral de color va por **tipo**,
     no por severidad), fecha/hora local, mensaje y acciones **Vista** (`acknowledgeAlert`) /
     **Descartar** (`dismissAlert`) cuando la alerta está en `NEW`.
- **Acción única "Analizar último día"**: persiste los ajustes actuales (`saveAlertConfig`), ejecuta
  `evaluateAlerts` y muestra **solo los tipos activos** (filtra en cliente las alarmas persistidas de
  tipos desactivados). No hay botón de guardar separado ni filtros de estado/tipo.
- **Configuración simplificada**: en pantalla solo se editan *sensibilidad* y *tipos activos*. Los
  umbrales (`limitThresholdPct`, `phantomThresholdKwh`) y las franjas de inactividad **no se editan en
  la UI**, pero se cargan y se **reenvían intactos** al guardar (para no romper, p. ej., el `PHANTOM`,
  que necesita sus franjas). La severidad no se muestra en esta versión de la demo.
- **Paleta**: los tipos usan solo tonos de **azul y amarillo** (Anomalía azul oscuro · Fantasma azul
  medio · Límite ámbar · Estimado amarillo suave).
- **Comportamiento**: la lista arranca vacía y **se vacía al cambiar de suministro** (hay que volver a
  pulsar *Analizar*). No hay banner de latencia (se omitió para simplificar; el aviso D-1/D-2 queda
  como decisión de producto si se reincorpora).
- **Demo**: un `demoAlertDataSource` genera ≥ 13 semanas de curva determinista con anomalías sembradas
  (un pico para `ZSCORE`, consumo nocturno para `PHANTOM`, una hora cerca del límite para `LIMIT`, un
  intervalo `estimated` para `ESTIMATED`), de modo que `evaluateAlerts` produzca los cuatro tipos. La
  `AlertConfig` viene **sembrada** para ambos CUPS demo (incluida la franja de inactividad nocturna).

---

## 6. M04 — KPI de coste energético por unidad producida

Cruza la **curva de consumo** ya ingestada (`hourly_consumption`) con un **fichero de producción** que
el cliente sube (tramos de tiempo con unidades fabricadas) para calcular el **coste energético por
unidad producida (€/ud)**, su evolución temporal y los tramos atípicos. Es el **diferenciador** del
producto: ningún competidor "lite" cruza energía con producción real. Como M01/M02, el cálculo puro
vive en un módulo nuevo `packages/kpi-engine` (sin I/O); a diferencia de M03, **no hay job ni estado de
ciclo de vida**: el cliente sube un fichero y dispara el cálculo bajo demanda.

### 6.0 Decisiones de diseño (premisas de este módulo)

> **Entrada por fichero parseado en el front — sin infraestructura de upload en el servidor.** El
> navegador lee y parsea el fichero (**CSV** nativo, **Excel `.xlsx`** con SheetJS) y envía las filas
> ya estructuradas como **array JSON** en una mutation GraphQL normal (`submitProductionData`). El
> servidor **no** añade `multer`, `graphql-upload`, `multipart` ni `apollo-upload-client`: mantiene el
> patrón HTTP-plano actual. La librería `xlsx` vive **solo en el front**. El backend **revalida
> siempre** las filas (no se fía del cliente). *(Trade-off asumido: el fichero binario original no se
> persiste; se guardan las filas parseadas. Apto para ficheros pequeños —producción mensual/horaria,
> cientos de filas—. Si en el futuro se requieren ficheros grandes o conservar el original, se
> reconsidera un upload al backend.)*

> **Modelo de coste — coste variable de energía.** El € atribuido a cada kWh consumido es
> `PVPC_horario + peaje_energía_período + cargo_energía_período`, **idéntico al término de energía de
> M01** (§3.4) y a sus maestros (`TollRate`/`ChargeRate` de tipo `ENERGY`, measurement `pvpc_price`).
> Es el **coste marginal de la energía**: **excluye** término de potencia, alquiler de contador, IEE e
> IVA (costes fijos que no dependen de producir más o menos unidades). La composición del precio se
> hace en el servicio (reutilizando la lógica de M01) y se pasa al engine ya compuesta (`eurPerKwh`),
> de modo que el engine no conoce tarifas.

> **Sin estado ni job (a diferencia de M03).** El KPI no es un objeto con ciclo de vida; es el
> resultado de un cálculo. Se persiste un `ProductionUpload` (las filas subidas) y un `KpiReport` (el
> resultado, para histórico y evolución), pero el cálculo se dispara con una mutation (`computeKpi`),
> no con un cron. Recálculo idempotente por `(uploadId, granularity)`.

1. **Imputación proporcional consumo→tramo.** Un tramo de producción (p. ej. un turno 06:00–14:00)
   abarca varias horas de `hourly_consumption`. Se suma el `kwh` de las horas que **solapan** el tramo;
   si un borde cae a mitad de hora, esa hora pondera por `segundosSolapados / duraciónDelBucket`. La
   granularidad mínima fiable es **horaria**: si el tramo es más corto que una hora se imputa la
   fracción proporcional, asumiendo consumo uniforme dentro de la hora (limitación documentada).

2. **Detección de outliers ±20 % sobre baseline.** La baseline es la **mediana** de €/ud de los buckets
   agregados (robusta a los propios atípicos). Un bucket es `isOutlier` si
   `|€/ud − baseline| > outlierPct × baseline` (`outlierPct` default **0.20**).

3. **Caveat crítico — KPI por línea/lote con un único CUPS.** DATADIS entrega el consumo **total del
   punto de suministro (CUPS)**, no separable por línea de producción. Por tanto el coste **no puede
   desagregarse por `linea`/`lote`** cuando hay producción **paralela** (varias líneas consumiendo a la
   vez del mismo CUPS). En consecuencia: la **granularidad de agregación es temporal** (turno/día/
   semana/mes); `linea` y `lote` se conservan como **metadatos** del tramo pero **no** son ejes de
   agregación de €/ud. Si **cualquier** par de tramos **se solapa en el tiempo**, el fichero se
   **rechaza** con `KPI_OVERLAPPING_INTERVALS` (no se acepta con aviso): imputar el mismo consumo a dos
   tramos solapados duplicaría kWh y coste y rompería los totales, y con un CUPS único no hay forma
   correcta de repartir el consumo entre líneas paralelas. La validación de solape vive en
   `submitProductionData` (§6.5).

### 6.0bis Prerrequisitos de implementación

- **Nuevo paquete `packages/kpi-engine`**: función pura `computeKpi(input)` + utilidades
  (`overlapMs`, `median`). Mismo patrón que `alerts-engine`/`optimization-engine`: sin Prisma, sin
  InfluxDB, 100 % testeable con datos sintéticos. **No conoce tarifas ni husos horarios**: recibe el
  `eurPerKwh` ya compuesto y, en cada tramo, la hora local Madrid ya resuelta (`localStart`); la
  conversión de zona y la composición del precio las hace el servicio (`kpiService`).
- **Composición del precio en el servicio** reutilizando M01: `eurPerKwh_h = pvpc_h + tollEnergy[p] +
  chargeEnergy[p]` por período (la misma suma que `engine.ts` de `pricing-engine` en el término de
  energía). No se duplica el motor de factura; solo se reutiliza esa composición.
- **Nuevos modelos Prisma** `ProductionUpload`, `ProductionRow`, `KpiReport`, `KpiReportLine` +
  relaciones inversas en `Supply`. Como en M01/M02/M03, **no hay migración aplicada** (el repo nunca ha
  corrido contra Postgres real); se añaden a `schema.prisma`. En tests, cliente mockeado.
- **Data source de curva + precio** (`KpiDataSource` inyectable, espejo de los de M01–M03): real = Flux
  contra InfluxDB (`hourly_consumption` + `pvpc_price`) + maestros de energía desde PostgreSQL, ya
  compuesto en `eurPerKwh`; demo = generador determinista. Se inyecta vía `runtime.ts`
  (`setKpiDataSource`/`getKpiDataSource`).
- **Front**: nueva dependencia `xlsx` (SheetJS) **solo** en `apps/web` (parseo de `.xlsx` en cliente).
- **Patrón de tests**: Vitest; mock de Prisma con `vi.hoisted` (no `vitest-mock-extended`, ver §9.3).
- **Sin worker**: M04 no añade jobs a `apps/worker`.

### 6.1 Fuentes de datos

| Fuente | Endpoint / origen | Dato obtenido | Uso en M04 |
|--------|-------------------|---------------|------------|
| **Fichero del cliente** (CSV/`.xlsx`) | Parseado en el front, enviado como filas JSON | Tramos `(inicio, fin, unidades)` + opcionales `turno`/`línea`/`lote` | Numerador (unidades) y ejes de los tramos |
| InfluxDB | measurement `hourly_consumption` (`kwh`, `gap`) | Curva horaria del rango cubierto por la producción | Energía consumida por tramo (imputación) |
| InfluxDB | measurement `pvpc_price` | Precio horario PVPC (€/kWh) | Componente del `eurPerKwh` |
| PostgreSQL | `TollRate` / `ChargeRate` (tipo `ENERGY`, vigentes) | Peaje y cargo de energía por tarifa/período | Componentes del `eurPerKwh` (idéntico a M01) |

> **Sin ingesta nueva**: M04 consume lo que ya carga M01 (`hourly_consumption`, `pvpc_price`). No añade
> measurements, no llama a DATADIS/ESIOS durante el cálculo. El único dato externo nuevo es el fichero
> de producción, que entra por GraphQL (no por ingesta).
>
> **Rango**: el cálculo cubre `[min(startTs), max(endTs))` de las filas subidas. Si falta curva de
> consumo en parte del rango (huecos `gap`), esos tramos se marcan pero el cálculo no se bloquea.

### 6.2 Modelos Prisma

```prisma
// ─── Producción subida por el cliente (M04) ──────────────────────────────────

enum ProductionFileFormat { CSV  XLSX }
enum ProductionShift      { M  T  N }            // mañana / tarde / noche (opcional)
enum KpiGranularity       { SHIFT  DAY  WEEK  MONTH }

model ProductionUpload {
  id           String          @id @default(uuid())
  supplyId     String
  supply       Supply          @relation(fields: [supplyId], references: [id])
  fileName     String
  format       ProductionFileFormat
  rowCount     Int
  rangeStart   DateTime        // min(startTs) de las filas (UTC)
  rangeEnd     DateTime        // max(endTs) de las filas (UTC)
  uploadedAt   DateTime        @default(now())
  uploadedBy   String?         // userId que la subió
  rows         ProductionRow[]
  reports      KpiReport[]
}

model ProductionRow {
  id        String           @id @default(uuid())
  uploadId  String
  upload    ProductionUpload @relation(fields: [uploadId], references: [id], onDelete: Cascade)
  startTs   DateTime         // inicio del tramo (UTC)
  endTs     DateTime         // fin del tramo (UTC); endTs > startTs
  units     Float            // unidades producidas en el tramo; > 0
  shift     ProductionShift?
  line      String?          // metadato (ver caveat §6.0 punto 3)
  batch     String?          // metadato (lote)
}

// ─── Resultado del cálculo de KPI (M04) ──────────────────────────────────────

model KpiReport {
  id                String          @id @default(uuid())
  supplyId          String
  supply            Supply          @relation(fields: [supplyId], references: [id])
  uploadId          String
  upload            ProductionUpload @relation(fields: [uploadId], references: [id], onDelete: Cascade)
  granularity       KpiGranularity
  rangeStart        DateTime
  rangeEnd          DateTime
  totalUnits        Float
  totalKwh          Float
  totalCostEur      Float
  avgEurPerUnit     Float           // totalCostEur / totalUnits
  baselineEurPerUnit Float          // mediana de €/ud de los buckets (referencia de outliers)
  outlierPct        Float           @default(0.20)
  hasGaps           Boolean         @default(false) // algún tramo con consumo imputado sobre gap
  computedAt        DateTime        @default(now())
  lines             KpiReportLine[]
  @@unique([uploadId, granularity])  // idempotencia del recálculo
}

model KpiReportLine {
  id          String    @id @default(uuid())
  reportId    String
  report      KpiReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  bucketKey   String    // "2026-06-01#M" | "2026-06-01" | "2026-W23" | "2026-06" (calendario local Madrid)
  bucketStart DateTime  // inicio del bucket (para ordenar la evolución temporal)
  units       Float
  kwh         Float
  costEur     Float
  eurPerUnit  Float     // costEur / units
  isOutlier   Boolean   @default(false)
}
```

> **Cambios en `Supply`**: añadir las relaciones inversas `productionUploads ProductionUpload[]` y
> `kpiReports KpiReport[]`. No se modifica ningún otro modelo de M01/M02/M03.

> **Portabilidad**: como en M03, las claves de bucket se guardan como texto. El recálculo del mismo
> `(uploadId, granularity)` sustituye el `KpiReport` previo (idempotente).

### 6.3 Esquema InfluxDB

M04 **no define measurements nuevos**. Lee `hourly_consumption` (`kwh`, tag `gap`) y `pvpc_price`
(§3.3). La asignación de `period` (para casar peaje/cargo de energía) y la hora local (para los buckets
por día/turno) usan el mismo calendario tarifario de la ingesta (§3.3). El measurement `max_power`
**no** se usa en M04.

### 6.4 Algoritmo de cálculo — paso a paso

El cálculo puro vive en `packages/kpi-engine` (`computeKpi`): sin I/O. El servicio carga la curva y
compone `eurPerKwh` (vía `KpiDataSource`), valida las filas y persiste el `KpiReport`.

#### Responsabilidad del servicio / data source (construcción de inputs)

| Campo del input | Cómo lo construye el servicio / data source |
|-----------------|---------------------------------------------|
| `production[]` | filas validadas del `ProductionUpload` (`startTs`, `endTs`, `units`, `shift?`, `line?`, `batch?`) |
| `consumption[]` | buckets `(ts, hours, kwh, eurPerKwh, gap)` de `hourly_consumption` sobre `[rangeStart, rangeEnd)`, con `eurPerKwh = pvpc_h + tollEnergy[p] + chargeEnergy[p]` (composición de M01) |
| `granularity` | `SHIFT` \| `DAY` \| `WEEK` \| `MONTH` (parámetro de la mutation) |
| `outlierPct` | umbral relativo de outlier (default 0.20) |

> Validaciones **antes** de invocar al engine: `SUPPLY_NOT_FOUND`, `BACKFILL_*` (histórico no listo,
> §3.5), `KPI_NO_PRODUCTION_DATA` (upload sin filas válidas), `NO_CONSUMPTION_DATA` (sin curva en el
> rango). La validación por fila (`KPI_INVALID_ROW`, `KPI_OVERLAPPING_INTERVALS`) ocurre en
> `submitProductionData` (ver §6.5).

#### Interfaz del kpi-engine

```typescript
// ─── Input ──────────────────────────────────────────────────────────────────

interface ConsumptionHour {
  ts: string;        // ISO UTC, inicio del bucket
  hours: number;     // duración del bucket en horas (1 | 0.25)
  kwh: number;
  eurPerKwh: number; // pvpc + peajeE[p] + cargoE[p], ya compuesto (idéntico a M01)
  gap: boolean;      // imputado/estimado (no facturable) → marca de calidad
}

interface ProductionInterval {
  startTs: string; endTs: string;   // ISO UTC, endTs > startTs
  localStart: string;               // "YYYY-MM-DDTHH:mm:ss" hora local Madrid (resuelta por el servicio)
  units: number;                    // > 0
  shift?: 'M'|'T'|'N'; line?: string; batch?: string;
}

interface KpiInput {
  production:  ProductionInterval[];
  consumption: ConsumptionHour[];    // ordenado por ts, cubre el rango
  granularity: 'SHIFT'|'DAY'|'WEEK'|'MONTH';
  outlierPct:  number;               // default 0.20
}

// ─── Output ─────────────────────────────────────────────────────────────────

interface KpiIntervalResult {        // un resultado por tramo de producción
  startTs: string; endTs: string; units: number;
  shift?: 'M'|'T'|'N'; line?: string; batch?: string;
  kwh: number; costEur: number; eurPerUnit: number;
  hasGap: boolean;                   // algún bucket imputado con gap=true
}

interface KpiBucket {                // agregado por granularidad temporal
  key: string; bucketStart: string;
  units: number; kwh: number; costEur: number; eurPerUnit: number;
  isOutlier: boolean;
}

interface KpiResult {
  intervals: KpiIntervalResult[];
  buckets:   KpiBucket[];            // ordenados por bucketStart (evolución temporal)
  baselineEurPerUnit: number;        // mediana de buckets[].eurPerUnit
  totalUnits: number; totalKwh: number; totalCostEur: number; avgEurPerUnit: number;
  hasGaps: boolean;
}

function computeKpi(input: KpiInput): KpiResult;
```

#### Paso 1 — Imputación de consumo a cada tramo

Para cada `ProductionInterval` `[startTs, endTs)`, recorrer los `ConsumptionHour` que solapan y acumular:

```
para cada bucket h con [h.start, h.end) ∩ [startTs, endTs) = [a, b), b > a:
  frac        = (b − a) / (h.end − h.start)      // fracción del bucket dentro del tramo (0..1]
  kwhTramo   += h.kwh * frac
  costeTramo += h.kwh * frac * h.eurPerKwh
  si h.gap: hasGap = true
```

`kwh = kwhTramo`, `costEur = costeTramo`. Sin redondeo intermedio.

#### Paso 2 — €/unidad por tramo

```
eurPerUnit = costEur / units            // units > 0 garantizado por validación
```

#### Paso 3 — Agregación por granularidad (calendario local Madrid)

Cada tramo se asigna a un bucket según `granularity`, usando el **día/hora local** de `startTs`:

| Granularidad | `key` | Notas |
|--------------|-------|-------|
| `SHIFT` | `"YYYY-MM-DD#<shift>"` | `shift` del tramo; tramos sin `shift` → `#SIN` |
| `DAY`   | `"YYYY-MM-DD"` | |
| `WEEK`  | `"YYYY-Www"` (ISO week) | |
| `MONTH` | `"YYYY-MM"` | |

Por bucket: `units = Σ`, `kwh = Σ`, `costEur = Σ`, `eurPerUnit = costEur / units`. (Se agrega coste y
unidades y se divide al final — **no** se promedian los €/ud de los tramos.)

#### Paso 4 — Baseline y detección de outliers

```
baseline = median(buckets[].eurPerUnit)
para cada bucket: isOutlier = |bucket.eurPerUnit − baseline| > outlierPct * baseline
```

#### Paso 5 — Totales y evolución temporal

```
totalUnits   = Σ units;   totalKwh = Σ kwh;   totalCostEur = Σ costEur
avgEurPerUnit = totalCostEur / totalUnits
buckets ordenados por bucketStart → serie de evolución de €/ud
```

#### Notas de precisión y redondeo

- Mismo criterio que §3.4 / §4.4 / §5.4: **sin redondeo intermedio**; el engine nunca redondea.
  Imputación, costes, €/ud y mediana en doble precisión; el redondeo a 2 decimales es de presentación.
- Tests de €/ud y € con tolerancia `±0.001`; conteo de unidades y kWh con `±0.001`.

#### Calidad de dato

Un tramo con `hasGap = true` (consumo imputado sobre huecos) se marca; el `KpiReport.hasGaps` agrega la
señal. La UI muestra un **banner amarillo no bloqueante** (como M01/M03); el cálculo **no se bloquea**.

### 6.5 Esquema GraphQL

```graphql
type ProductionUpload {
  id:         ID!
  supplyId:   String!
  fileName:   String!
  format:     String!   # "CSV" | "XLSX"
  rowCount:   Int!
  rangeStart: String!   # ISO 8601 UTC
  rangeEnd:   String!
  uploadedAt: String!
}

type KpiReportLine {
  bucketKey:   String!
  bucketStart: String!  # ISO 8601 UTC
  units:       Float!
  kwh:         Float!
  costEur:     Float!
  eurPerUnit:  Float!
  isOutlier:   Boolean!
}

type KpiReport {
  id:                 ID!
  supplyId:           String!
  uploadId:           String!
  granularity:        String!   # "SHIFT" | "DAY" | "WEEK" | "MONTH"
  rangeStart:         String!
  rangeEnd:           String!
  totalUnits:         Float!
  totalKwh:           Float!
  totalCostEur:       Float!
  avgEurPerUnit:      Float!
  baselineEurPerUnit: Float!
  outlierPct:         Float!
  hasGaps:            Boolean!
  computedAt:         String!
  lines:              [KpiReportLine!]!   # ordenadas por bucketStart (evolución)
}

input ProductionRowInput {
  startTs: String!   # ISO 8601 (parseado en el front a UTC)
  endTs:   String!
  units:   Float!
  shift:   String    # "M" | "T" | "N"
  line:    String
  batch:   String
}

input SubmitProductionInput {
  cups:     String!
  fileName: String!
  format:   String!                     # "CSV" | "XLSX"
  rows:     [ProductionRowInput!]!
}

input ComputeKpiInput {
  uploadId:    String!
  granularity: String       # default "DAY"
  outlierPct:  Float        # default 0.20
}

extend type Query {
  productionUploads(supplyId: String!): [ProductionUpload!]!
  kpiReport(id: ID!): KpiReport
  kpiReports(supplyId: String!): [KpiReport!]!
}

extend type Mutation {
  # Valida y persiste las filas parseadas en el front (CSV/XLSX). Devuelve el upload creado.
  submitProductionData(input: SubmitProductionInput!): ProductionUpload!

  # Calcula (o recalcula, idempotente por uploadId+granularity) y persiste el KpiReport.
  computeKpi(input: ComputeKpiInput!): KpiReport!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` / `BACKFILL_RUNNING` / `BACKFILL_FAILED` | El histórico aún no está disponible (§3.5) |
| `KPI_INVALID_ROW` | Fila con `endTs ≤ startTs`, `units ≤ 0` o timestamp no parseable |
| `KPI_OVERLAPPING_INTERVALS` | Tramos del mismo ámbito que se solapan en el tiempo (ver caveat §6.0 punto 3) |
| `KPI_NO_PRODUCTION_DATA` | `submitProductionData` sin filas, o `computeKpi` sobre un upload vacío |
| `KPI_UPLOAD_NOT_FOUND` | `computeKpi` sobre un `uploadId` inexistente |
| `KPI_REPORT_NOT_FOUND` | `kpiReport(id)` — *devuelve `null`, no error* (consistente con `alert(id)`) |
| `NO_CONSUMPTION_DATA` | No hay curva (`hourly_consumption`) en el rango del upload |

> **Autorización** (§2.2): leer (`productionUploads`, `kpiReport`, `kpiReports`) → `assertSupplyAccess`
> (DOMINION todo; ADMIN su cliente; GESTOR/USUARIO su suministro). Escribir
> (`submitProductionData`, `computeKpi`) → rol de escritura (DOMINION/ADMIN/GESTOR); `USUARIO` es **solo
> lectura** (mismo criterio que `savePreInvoice`/`savePowerOptimization`/`saveAlertConfig`).

### 6.6 Casos de test — contrato de implementación

> Los tests del `kpi-engine` son unitarios (sin I/O). Los del resolver/servicio son de integración con
> Prisma e InfluxDB mockeados. Nomenclatura `TC-KPI-NNN` (§9.1).

#### TC-KPI-001 — Imputación de tramo alineado a horas — Unit

Tramo `06:00–10:00` (4 h) sobre buckets horarios `kwh=[10,10,10,10]`, `eurPerKwh=0.20` → `kwh=40`,
`costEur=8.0`. Con `units=80` → `eurPerUnit=0.10`. Verifica suma e imputación sin fracciones.

#### TC-KPI-002 — Imputación con bordes a mitad de hora — Unit

Tramo `06:30–08:30` sobre buckets de 1 h: bucket 06:00 aporta `frac=0.5`, 07:00 `frac=1.0`, 08:00
`frac=0.5`. Con `kwh=[10,10,10]` → `kwhTramo = 5+10+5 = 20`. Confirma la ponderación proporcional.

#### TC-KPI-003 — Cuarto-horario (hours=0.25) — Unit

Buckets de 15 min (`hours=0.25`) cubriendo un tramo exacto → la fracción usa `(b−a)/0.25h`. Verifica que
la duración del bucket, no la hora fija, gobierna la ponderación.

#### TC-KPI-004 — Coste = kWh × eurPerKwh compuesto — Unit

`eurPerKwh` distinto por bucket (p. ej. PVPC variable + peaje/cargo) → `costEur = Σ kwh·frac·eurPerKwh`.
Verifica que el engine respeta el precio por bucket (no promedia).

#### TC-KPI-005 — €/unidad por tramo — Unit

`costEur=12`, `units=240` → `eurPerUnit=0.05`. `units` distinto por tramo produce €/ud distinto.

#### TC-KPI-006 — Agregación DAY suma coste y unidades — Unit

Dos tramos el mismo día (`costEur=[6,4]`, `units=[60,40]`) → bucket `DAY`: `costEur=10`, `units=100`,
`eurPerUnit=0.10`. Confirma que **se divide al final**, no se promedian los €/ud (0.10 y 0.10 aquí, pero
con `costEur=[6,4]`/`units=[40,60]` daría 0.10 agregado ≠ media de 0.15 y 0.0667).

#### TC-KPI-007 — Agregación SHIFT y "sin turno" — Unit

Tramos con `shift` M/T/N → tres buckets `YYYY-MM-DD#M|T|N`; un tramo sin `shift` → bucket `#SIN`.

#### TC-KPI-008 — Agregación WEEK (ISO) y MONTH — Unit

Tramos en semanas/meses distintos → claves `YYYY-Www` / `YYYY-MM` correctas (incluida frontera de año).

#### TC-KPI-009 — Baseline = mediana de buckets — Unit

`eurPerUnit` de buckets `[0.10, 0.11, 0.09, 0.50]` → `baseline = mediana = 0.105`. Verifica mediana
(robusta), no media.

#### TC-KPI-010 — Outlier ±20 % sobre baseline — Unit

Con `baseline=0.10`, `outlierPct=0.20`: bucket `0.13` → `isOutlier` (>0.12); `0.11` → no; `0.07` →
`isOutlier` (<0.08, también a la baja).

#### TC-KPI-011 — Tramo con gap marca hasGap — Unit

Tramo cuyo consumo procede de buckets con `gap=true` → `hasGap=true` en el tramo y `hasGaps=true` en el
resultado. El cálculo **no** se aborta.

#### TC-KPI-012 — Totales y orden de evolución — Unit

`totalCostEur`/`totalUnits`/`avgEurPerUnit` correctos; `buckets` devueltos ordenados por `bucketStart`.

#### TC-KPI-013 — submitProductionData valida y persiste — Integration

Filas válidas → crea `ProductionUpload` + `ProductionRow[]`, calcula `rangeStart/rangeEnd` y `rowCount`.
Sin filas → `KPI_NO_PRODUCTION_DATA`.

#### TC-KPI-014 — Fila inválida → KPI_INVALID_ROW — Integration

`endTs ≤ startTs`, `units ≤ 0` o timestamp no parseable → `KPI_INVALID_ROW` (no persiste nada).

#### TC-KPI-015 — Tramos solapados → KPI_OVERLAPPING_INTERVALS — Integration

Dos tramos del mismo ámbito con solape temporal → `KPI_OVERLAPPING_INTERVALS` (ver caveat §6.0 punto 3).

#### TC-KPI-016 — computeKpi calcula y persiste — Integration

Upload válido + curva disponible → `KpiReport` con `lines` por bucket. `uploadId` inexistente →
`KPI_UPLOAD_NOT_FOUND`; sin curva en el rango → `NO_CONSUMPTION_DATA`.

#### TC-KPI-017 — computeKpi idempotente por (uploadId, granularity) — Integration

Dos llamadas con el mismo `uploadId` y `granularity` actualizan el **mismo** `KpiReport` (por
`@@unique`), no duplican. Distinta `granularity` → report distinto.

#### TC-KPI-018 — Reutiliza la composición de precio de M01 — Integration

El `eurPerKwh` por hora coincide con `pvpc_h + tollEnergy[p] + chargeEnergy[p]` (mismos maestros que
M01); un cambio de PVPC/peaje altera el coste de forma coherente.

#### TC-KPI-019 — Consultas y autorización — Integration

`productionUploads`/`kpiReports` filtran por supply; `kpiReport(id)` inexistente → `null`. `USUARIO`
sobre `submitProductionData`/`computeKpi` → `FORBIDDEN`; `ADMIN` de otro cliente sobre datos ajenos →
`FORBIDDEN` (reglas §2.2).

#### TC-KPI-020 — Backfill no listo → BACKFILL_* — Integration

`backfillStatus = PENDING/RUNNING/FAILED` → `BACKFILL_PENDING`/`BACKFILL_RUNNING`/`BACKFILL_FAILED`
(mismo contrato que §3.7 / §4.6 / §5.6).

### 6.7 Front (apps/web) — no normativo en lo visual

> Como en M02/M03 (§4.7/§5.7), el detalle visual no es contrato; el **flujo de datos** (mutations/queries
> que invoca) **sí** lo es. Se prioriza la claridad y se documenta la pantalla para enseñar el módulo en
> modo demo.

- **Topbar**: nueva entrada **KPI** junto a Pre-factura / Optimización / Alertas (`shared/topbar.component.ts`).
- **Ruta** `/kpi` (protegida por `authGuard`) → `KpiComponent`. Reutiliza `GraphqlService` (HTTP-plano).
- **Carga del fichero**: `<input type="file" accept=".csv,.xlsx">`. El parseo es **en el cliente**: CSV
  con un parser ligero propio; `.xlsx` con **SheetJS** (`xlsx`). Se mapean las columnas
  `timestamp_inicio` / `timestamp_fin` / `unidades_producidas` (+ opcionales `turno`/`linea`/`lote`) a
  `ProductionRowInput`.
- **Previsualización**: tabla de las filas parseadas + recuento antes de enviar; avisos de validación en
  cliente (fechas, unidades), que el backend **revalida**.
- **Flujo**: botón **Calcular KPI** → `submitProductionData` → `computeKpi(granularity)`. Selector de
  **granularidad** (Turno / Día / Semana / Mes).
- **Resultado**: tabla de **€/ud por bucket** con los **outliers resaltados**, KPI medio (`avgEurPerUnit`)
  y una **serie/gráfico de evolución** temporal (orden por `bucketStart`). **Banner amarillo** no
  bloqueante si `hasGaps`.
- **Paleta**: coherente con M03 (azul/amarillo); outliers en ámbar.

### 6.8 Modo demo (para probar `/kpi` sin DBs reales)

Mismo mecanismo de holders que M01–M03 (`runtime.ts`), arrancando con `npm run demo`:

- **`makeDemoKpiDataSource()`**: genera una curva horaria determinista de `hourly_consumption` + un
  `pvpc_price` determinista sobre el rango y compone el `eurPerKwh` (reutiliza el patrón de
  `demoAlertDataSource.ts`; sin `Math.random()`, reproducible). En `index.ts` se inyecta
  `makeInfluxKpiDataSource(queryApi)`; en `demo.ts`, `makeDemoKpiDataSource()`.
- **`ProductionUpload` demo sembrado** en el store en memoria (`demo/store.ts`): varios días con turnos
  M/T/N y **al menos un tramo de €/ud claramente atípico** (p. ej. un turno con baja producción y
  consumo normal) para ejercitar la detección de outliers ±20 %. Así la pantalla `/kpi` muestra datos al
  entrar **sin** necesidad de subir fichero, y el flujo de subida sigue siendo probable.
- **Delegados Prisma** en `store.ts` para `productionUpload`, `productionRow`, `kpiReport`,
  `kpiReportLine`, sembrados en ambos CUPS demo.
- **Resultado esperado documentado**: en demo, `computeKpi(uploadId, "DAY")` produce un `KpiReport` con
  `lines` por día, `baselineEurPerUnit` coherente y **≥ 1** línea con `isOutlier = true`; el recálculo
  con el mismo `(uploadId, granularity)` es idempotente (no duplica).

---

## 7. M05 — Huella de carbono

Cruza la **curva de consumo** ya ingestada (`hourly_consumption`) con el **factor de emisión horario**
de la generación eléctrica peninsular para calcular las **emisiones de CO₂ asociadas al consumo**
(kgCO₂eq), su evolución mensual/anual y la **comparación con la media nacional** del periodo. Es
material directo de **reporting CSRD** (Corporate Sustainability Reporting Directive), obligatorio para
empresas industriales medianas/grandes en la UE. Como M01/M02/M04, el cálculo puro vive en un módulo
nuevo `packages/carbon-engine` (sin I/O); como M04, **no hay job ni estado de ciclo de vida**: el
cliente dispara el cálculo bajo demanda.

### 7.0 Decisiones de diseño (premisas de este módulo)

> **El factor de emisión se *compone* del mix de generación — REData no publica un factor directo.** El
> endpoint de REData `estructura-generacion` (apidatos.ree.es) devuelve el **mix horario de generación
> por tecnología** (% y MW), no un factor de emisión gCO₂/kWh. Por tanto el factor horario se calcula
> como `factor_h = Σ (porcentaje_tecnología_h × coef_CO₂_tecnología)`. Esto da **granularidad horaria
> real** (el diferenciador: emisiones que dependen de *cuándo* consume el cliente, no de un promedio
> anual plano).

> **Coeficientes por tecnología = tabla constante documentada, no config por cliente.** Los coeficientes
> de emisión por tecnología son constantes nacionales (operacionales de combustión, fuentes IPCC / REE /
> MITECO), no varían por suministro ni por tarifa. Viven como **tabla constante** en
> `packages/data-collector` (`emissionCoefficients.ts`), igual que el calendario tarifario de
> `periods.ts` vive como código. **No** se añade un maestro Prisma (a diferencia de los peajes/cargos de
> M01, que sí son regulatorios y cambian por tarifa). Valores de partida (gCO₂/kWh), a calibrar con la
> publicación oficial vigente:
>
> | Tecnología (REData) | coef. gCO₂/kWh | | Tecnología (REData) | coef. gCO₂/kWh |
> |---------------------|---------------:|-|---------------------|---------------:|
> | Nuclear | 0 | | Solar fotovoltaica | 0 |
> | Hidráulica | 0 | | Solar térmica | 0 |
> | Eólica | 0 | | Turbinación bombeo | 0 |
> | Ciclo combinado | 370 | | Cogeneración | 400 |
> | Carbón | 950 | | Residuos | 700 |

> **La comparación con "media nacional" es auto-contenida.** No se necesita una fuente extra (MITECO):
> el **factor propio** del cliente es el factor **ponderado por su consumo**
> (`Σ(kwh_h·factor_h)/Σ kwh_h`), y la **media nacional** es la **media temporal** del factor en el mismo
> periodo (`mean(factor_h)`, el "kWh medio de la red"). El `deltaPct = (propio − nacional) / nacional`
> indica si el cliente consume en horas más limpias (negativo, mejor) o más sucias (positivo, peor) que
> la media. Mismo periodo, sin sesgo de comparar contra otro año.

> **Sin estado ni job (como M04).** La huella es el resultado de un cálculo, no un objeto con ciclo de
> vida. Se persiste un `CarbonReport` (+ líneas mensuales) para histórico/evolución, pero se dispara con
> una mutation (`computeCarbonFootprint`), no con un cron. Recálculo idempotente por
> `(supplyId, rangeStart, rangeEnd)`.

1. **Granularidad y península (v1).** El factor se calcula a resolución **horaria** (se agrega el mix de
   REData a hora si llega en tramos de 10 min). v1 cubre el sistema **peninsular** (`system=peninsula`);
   Canarias/Baleares/Ceuta/Melilla quedan fuera de alcance (sus mix y factores difieren; se documenta).

2. **Calidad de dato (gaps).** Una hora de consumo con `gap=true` (imputado/estimado por M01) propaga
   `hasGaps`; el bucket mensual y el `CarbonReport` agregan la señal. La UI muestra un **banner amarillo
   no bloqueante** (como M01/M03/M04); el cálculo **no se bloquea**.

### 7.0bis Prerrequisitos de implementación

- **Nuevo paquete `packages/carbon-engine`**: función pura `computeCarbonFootprint(input)` + utilidades
  (`weightedMean`, `mean`). Mismo patrón que `kpi-engine`/`alerts-engine`: sin Prisma, sin InfluxDB,
  100 % testeable con datos sintéticos. **No conoce husos ni la fuente del factor**: recibe el factor
  horario ya compuesto (gCO₂/kWh) y cada hora con su **mes local Madrid ya resuelto** (`month`); la
  conversión de zona la hace el servicio.
- **Nuevo adaptador `packages/data-collector/src/redata.ts`**: `fetchGenerationMix(http, {from, to})`
  (llama a `estructura-generacion`) + `genMixToCo2Point(mixHour, coeffs)` (transforma el mix horario en
  un punto `co2_factor` componiendo `Σ %·coef`). Cliente HTTP REData en `http.ts` (sin auth, como ESIOS
  pero sin api-key). Tabla `emissionCoefficients.ts`. Exportado en `index.ts`.
- **Ingesta on-demand de `co2_factor`** (espejo del PVPC de M01, §1.4): el servicio comprueba si
  InfluxDB ya cubre el rango; si falta, pide el mix a REData, compone el factor y lo escribe en
  `co2_factor`. **Worker cron opcional/futuro** (un `daily-co2-factor` análogo al PVPC), **no en v1**.
- **Nuevos modelos Prisma** `CarbonReport`, `CarbonReportLine` + relaciones inversas en `Supply`. Como en
  M01–M04, **no hay migración aplicada** (el repo nunca ha corrido contra Postgres real); se añaden a
  `schema.prisma`. En tests, cliente mockeado.
- **Data source** `CarbonDataSource` inyectable (espejo de los de M01–M04): real = Flux contra InfluxDB
  (`hourly_consumption` + `co2_factor`) con la ingesta on-demand del factor; demo = generador
  determinista. Se inyecta vía `runtime.ts` (`setCarbonDataSource`/`getCarbonDataSource`).
- **Variable de entorno** `REDATA_URL` (default `http://localhost:3002`, ya en la tabla de adaptadores
  §1.2). Sin nueva dependencia de front.
- **Patrón de tests**: Vitest; mock de Prisma con `vi.hoisted` (no `vitest-mock-extended`, ver §9.3).
- **Sin worker**: M05 no añade jobs a `apps/worker` en v1.

### 7.1 Fuentes de datos

| Fuente | Endpoint / origen | Dato obtenido | Uso en M05 |
|--------|-------------------|---------------|------------|
| **REData** | `GET /es/datos/generacion/estructura-generacion` (`start_date`, `end_date`, `time_trunc=hour`) | Mix horario de generación por tecnología (`included[].attributes.values[]`: `percentage`, `value` MW, `datetime`) | Componer el factor de emisión horario |
| InfluxDB | measurement `hourly_consumption` (`kwh`, tag `gap`) | Curva horaria del rango solicitado | Energía consumida por hora |
| InfluxDB | measurement `co2_factor` (tag `system`, field `g_per_kwh`) | Factor de emisión horario ya compuesto | Factor por hora (escrito por la ingesta on-demand) |

> **Única ingesta nueva**: `co2_factor`. La curva de consumo ya la carga M01 (backfill + job diario,
> §1.5). El factor se compone en la ingesta (mix → `Σ %·coef`) y se cachea en InfluxDB para no repetir
> llamadas a REData. No se llama a REData durante el cálculo si el rango ya está cubierto.
>
> **Rango**: el cálculo cubre `[from, to)` (parámetros de la mutation). Si falta curva de consumo en
> parte del rango (huecos `gap`), esas horas se marcan pero el cálculo no se bloquea.

### 7.2 Modelos Prisma

```prisma
// ─── Huella de carbono (M05) ─────────────────────────────────────────────────

model CarbonReport {
  id                String             @id @default(uuid())
  supplyId          String
  supply            Supply             @relation(fields: [supplyId], references: [id])
  rangeStart        DateTime           // inicio del periodo (UTC)
  rangeEnd          DateTime           // fin del periodo (UTC)
  totalKwh          Float
  totalCo2Kg        Float              // emisiones totales kgCO₂eq
  ownFactorGPerKwh  Float              // factor ponderado por consumo (gCO₂/kWh)
  nationalAvgFactor Float              // media temporal del factor en el periodo (gCO₂/kWh)
  deltaPct          Float              // (ownFactor − national) / national
  hasGaps           Boolean            @default(false)
  computedAt        DateTime           @default(now())
  lines             CarbonReportLine[]
  @@unique([supplyId, rangeStart, rangeEnd])  // idempotencia del recálculo
}

model CarbonReportLine {
  id          String       @id @default(uuid())
  reportId    String
  report      CarbonReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  monthKey    String       // "YYYY-MM" (calendario local Madrid)
  monthStart  DateTime     // inicio del mes (para ordenar la evolución)
  kwh         Float
  co2Kg       Float
  factorAvg   Float        // factor medio del mes (gCO₂/kWh)
  hasGaps     Boolean      @default(false)
}
```

> **Cambios en `Supply`**: añadir la relación inversa `carbonReports CarbonReport[]`. No se modifica
> ningún otro modelo de M01–M04.

> **Portabilidad**: como en M03/M04, las claves de mes se guardan como texto. El recálculo del mismo
> `(supplyId, rangeStart, rangeEnd)` sustituye el `CarbonReport` previo (idempotente).

### 7.3 Esquema InfluxDB

M05 define **un measurement nuevo**, `co2_factor`:

| Measurement | Tags | Fields | Escritura |
|-------------|------|--------|-----------|
| `co2_factor` | `system` (`peninsula` en v1) | `g_per_kwh` (factor horario compuesto) | Ingesta on-demand desde REData (mix → `Σ %·coef`) |

Reutiliza `hourly_consumption` (`kwh`, tag `gap`, §3.3). La composición mix → factor ocurre en la
**ingesta** (no en el engine, que lee el factor ya compuesto). La asignación de la hora local Madrid
para los buckets mensuales usa el mismo calendario que la ingesta (§3.3).

### 7.4 Algoritmo de cálculo — paso a paso

El cálculo puro vive en `packages/carbon-engine` (`computeCarbonFootprint`): sin I/O. El servicio carga
la curva y el factor (vía `CarbonDataSource`, garantizando la ingesta on-demand del factor) y persiste
el `CarbonReport`.

#### Responsabilidad del servicio / data source (construcción de inputs)

| Campo del input | Cómo lo construye el servicio / data source |
|-----------------|---------------------------------------------|
| `consumption[]` | buckets `(ts, month, kwh, gap)` de `hourly_consumption` sobre `[from, to)`, con `month` = "YYYY-MM" local Madrid ya resuelto |
| `factors[]` | buckets `(ts, gPerKwh)` de `co2_factor` sobre `[from, to)` (ingestados on-demand si faltan), alineados por `ts` con `consumption` |

> Validaciones **antes** de invocar al engine: `SUPPLY_NOT_FOUND`, `BACKFILL_*` (histórico no listo,
> §3.5), `NO_CONSUMPTION_DATA` (sin curva en el rango), `CO2_NO_FACTOR_DATA` (REData no devuelve mix para
> el rango y no hay factor cacheado).

#### Interfaz del carbon-engine

```typescript
// ─── Input ──────────────────────────────────────────────────────────────────

interface ConsumptionHour {
  ts: string;     // ISO UTC, inicio de la hora
  month: string;  // "YYYY-MM" local Madrid (resuelto por el servicio)
  kwh: number;
  gap: boolean;   // imputado/estimado → marca de calidad
}

interface Co2FactorHour {
  ts: string;       // ISO UTC, alineado con consumption
  gPerKwh: number;  // factor compuesto (Σ %·coef), gCO₂/kWh
}

interface CarbonInput {
  consumption: ConsumptionHour[];  // ordenado por ts
  factors:     Co2FactorHour[];    // mismo eje temporal que consumption
}

// ─── Output ─────────────────────────────────────────────────────────────────

interface CarbonMonthBucket {
  key: string; monthStart: string;   // "YYYY-MM"
  kwh: number; co2Kg: number; factorAvg: number;
  hasGaps: boolean;
}

interface CarbonResult {
  months: CarbonMonthBucket[];           // ordenados por monthStart (evolución)
  totalKwh: number; totalCo2Kg: number;
  ownFactorGPerKwh: number;              // ponderado por consumo
  nationalAvgFactorGPerKwh: number;      // media temporal del periodo
  deltaPct: number;                      // (own − national) / national
  hasGaps: boolean;
}

function computeCarbonFootprint(input: CarbonInput): CarbonResult;
```

#### Paso 1 — Emisiones por hora

Alineando `factors[]` con `consumption[]` por `ts`:

```
para cada hora h:
  co2Kg_h = h.kwh * factor_h / 1000        // gCO₂ → kgCO₂
  si h.gap: hasGap del mes = true
```

Sin redondeo intermedio.

#### Paso 2 — Agregación mensual (calendario local Madrid)

Cada hora se asigna a su bucket `month` ("YYYY-MM", ya local). Por bucket:
`kwh = Σ`, `co2Kg = Σ`, `factorAvg = Σ(kwh·factor)/Σ kwh` (factor medio ponderado del mes).

#### Paso 3 — Factor propio, media nacional y delta

```
ownFactorGPerKwh     = Σ(kwh_h · factor_h) / Σ kwh_h     // ponderado por consumo
nationalAvgFactor    = mean(factor_h)                     // media temporal del periodo
deltaPct             = (ownFactorGPerKwh − nationalAvgFactor) / nationalAvgFactor
```

`deltaPct < 0` → el cliente consume en horas más limpias que la media (mejor); `> 0`, peor.

#### Paso 4 — Totales y evolución temporal

```
totalKwh   = Σ kwh;   totalCo2Kg = Σ co2Kg
months ordenados por monthStart → serie de evolución de kgCO₂
```

#### Notas de precisión y redondeo

- Mismo criterio que §3.4 / §4.4 / §5.4 / §6.4: **sin redondeo intermedio**; el engine nunca redondea.
  Emisiones, factores ponderados y media en doble precisión; el redondeo es de presentación.
- Tests de kgCO₂ y factores con tolerancia `±0.001`.

### 7.5 Esquema GraphQL

```graphql
type CarbonReportLine {
  monthKey:   String!
  monthStart: String!   # ISO 8601 UTC
  kwh:        Float!
  co2Kg:      Float!
  factorAvg:  Float!    # gCO₂/kWh
  hasGaps:    Boolean!
}

type CarbonReport {
  id:                ID!
  supplyId:          String!
  rangeStart:        String!
  rangeEnd:          String!
  totalKwh:          Float!
  totalCo2Kg:        Float!
  ownFactorGPerKwh:  Float!
  nationalAvgFactor: Float!
  deltaPct:          Float!
  hasGaps:           Boolean!
  computedAt:        String!
  lines:             [CarbonReportLine!]!   # ordenadas por monthStart (evolución)
}

input ComputeCarbonInput {
  cups: String!
  from: String!   # ISO 8601 (inclusive)
  to:   String!   # ISO 8601 (exclusive)
}

extend type Query {
  carbonReport(id: ID!): CarbonReport
  carbonReports(supplyId: String!): [CarbonReport!]!
}

extend type Mutation {
  # Calcula (o recalcula, idempotente por supplyId+rango) y persiste la huella. Ingesta el factor
  # de REData on-demand si falta en InfluxDB.
  computeCarbonFootprint(input: ComputeCarbonInput!): CarbonReport!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` / `BACKFILL_RUNNING` / `BACKFILL_FAILED` | El histórico aún no está disponible (§3.5) |
| `NO_CONSUMPTION_DATA` | No hay curva (`hourly_consumption`) en el rango |
| `CO2_NO_FACTOR_DATA` | REData no devuelve mix para el rango y no hay factor cacheado en `co2_factor` |
| `CARBON_REPORT_NOT_FOUND` | `carbonReport(id)` — *devuelve `null`, no error* (consistente con `alert(id)`) |

> **Autorización** (§2.2): leer (`carbonReport`, `carbonReports`) → `assertSupplyAccess` (DOMINION
> todo; ADMIN su cliente; GESTOR/USUARIO su suministro). Escribir (`computeCarbonFootprint`) → rol de
> escritura (DOMINION/ADMIN/GESTOR); `USUARIO` es **solo lectura** (mismo criterio que el resto de
> módulos).

### 7.6 Casos de test — contrato de implementación

> Los tests del `carbon-engine` y de la composición del factor (`genMixToCo2Point`) son unitarios (sin
> I/O). Los del resolver/servicio son de integración con Prisma, InfluxDB y REData mockeados.
> Nomenclatura `TC-CO2-NNN` (§9.1).

#### TC-CO2-001 — Composición del factor desde el mix — Unit

`genMixToCo2Point` con mix `{Eólica 50 %, Ciclo combinado 30 %, Carbón 20 %}` y la tabla de
coeficientes → `factor = 0·0.5 + 370·0.3 + 950·0.2 = 301 gCO₂/kWh`. Verifica `Σ %·coef`.

#### TC-CO2-002 — Tecnologías limpias → coef 0 — Unit

Mix 100 % renovable/nuclear → `factor = 0`. Confirma que las tecnologías de la tabla con coef 0 no
emiten.

#### TC-CO2-003 — Emisiones por hora (g→kg) — Unit

`kwh=100`, `factor=300 gCO₂/kWh` → `co2Kg = 30`. Verifica la conversión `/1000`.

#### TC-CO2-004 — Agregación mensual suma kWh y CO₂ — Unit

Horas de un mismo mes → bucket con `kwh=Σ`, `co2Kg=Σ`, `factorAvg` ponderado por consumo.

#### TC-CO2-005 — factorAvg mensual ponderado por consumo — Unit

Dos horas `(kwh=10, factor=200)` y `(kwh=90, factor=400)` → `factorAvg = (10·200+90·400)/100 = 380`
(no media simple 300). Verifica ponderación.

#### TC-CO2-006 — Factor propio vs media nacional — Unit

Cliente que consume en horas limpias → `ownFactorGPerKwh < nationalAvgFactor` → `deltaPct < 0`. El caso
inverso (consumo en horas sucias) → `deltaPct > 0`.

#### TC-CO2-007 — deltaPct exacto — Unit

`ownFactor=240`, `national=300` → `deltaPct = (240−300)/300 = −0.20`.

#### TC-CO2-008 — Frontera de mes/año — Unit

Horas en diciembre y enero → claves `"YYYY-12"` / `"(YYYY+1)-01"` correctas; `months` ordenados por
`monthStart`.

#### TC-CO2-009 — Gap propaga hasGaps — Unit

Hora con `gap=true` → `hasGaps=true` en el mes y en el resultado. El cálculo **no** se aborta.

#### TC-CO2-010 — Totales — Unit

`totalKwh`/`totalCo2Kg` correctos sobre todo el periodo.

#### TC-CO2-011 — computeCarbonFootprint calcula y persiste — Integration

Curva + factor disponibles → `CarbonReport` con `lines` mensuales. Sin curva → `NO_CONSUMPTION_DATA`.

#### TC-CO2-012 — Ingesta on-demand del factor — Integration

`co2_factor` ausente en el rango → el servicio llama a REData (`estructura-generacion`), compone y
escribe el factor, y procede. REData sin datos para el rango → `CO2_NO_FACTOR_DATA`.

#### TC-CO2-013 — Idempotencia por (supplyId, rango) — Integration

Dos llamadas con el mismo `(cups, from, to)` actualizan el **mismo** `CarbonReport` (por `@@unique`),
no duplican.

#### TC-CO2-014 — Backfill no listo → BACKFILL_* — Integration

`backfillStatus = PENDING/RUNNING/FAILED` → `BACKFILL_PENDING`/`BACKFILL_RUNNING`/`BACKFILL_FAILED`
(mismo contrato que §3.7 / §4.6 / §5.6 / §6.6).

#### TC-CO2-015 — Consultas y autorización — Integration

`carbonReports` filtra por supply; `carbonReport(id)` inexistente → `null`. `USUARIO` sobre
`computeCarbonFootprint` → `FORBIDDEN`; `ADMIN` de otro cliente sobre datos ajenos → `FORBIDDEN`
(reglas §2.2).

### 7.7 Front (apps/web) — no normativo en lo visual

> Como en M02–M04 (§4.7/§5.7/§6.7), el detalle visual no es contrato; el **flujo de datos** (mutation/
> queries que invoca) **sí** lo es.

- **Topbar**: nueva entrada **Huella** junto a Pre-factura / Optimización / Alertas / KPI
  (`shared/topbar.component.ts`).
- **Ruta** `/huella` (protegida por `authGuard`) → `CarbonComponent`. Reutiliza `GraphqlService`.
- **Entradas**: selector de CUPS + rango de fechas (`from`/`to`).
- **Flujo**: botón **Calcular huella** → `computeCarbonFootprint(input)`.
- **Resultado**: total **kgCO₂eq**, serie/gráfico de **evolución mensual**, y la **comparativa** del
  factor propio vs media nacional (`deltaPct`, verde si negativo / rojo si positivo). **Banner amarillo**
  no bloqueante si `hasGaps`. Mensaje de contexto **CSRD**.

### 7.8 Modo demo (para probar `/huella` sin DBs reales)

Mismo mecanismo de holders que M01–M04 (`runtime.ts`), arrancando con `npm run demo`:

- **`makeDemoCarbonDataSource()`**: genera una curva horaria determinista (`hourly_consumption`) y un
  **factor horario determinista** (`co2_factor`) con forma realista (más limpio de día por la solar, más
  sucio en puntas), sin `Math.random()`. En `index.ts` se inyecta la fuente real (Flux + ingesta REData
  on-demand); en `demo.ts`, `makeDemoCarbonDataSource()`.
- **`CarbonReport` demo sembrado** en el store en memoria (`demo/store.ts`): varios meses con `deltaPct`
  claramente distinto de 0 (un perfil de consumo desplazado a horas limpias o sucias) para enseñar la
  comparativa. Así `/huella` muestra datos al entrar sin necesidad de calcular.
- **Delegados Prisma** en `store.ts` para `carbonReport`, `carbonReportLine`, sembrados en ambos CUPS
  demo.
- **Resultado esperado documentado**: en demo, `computeCarbonFootprint(cups, from, to)` produce un
  `CarbonReport` con `lines` mensuales, `deltaPct` coherente con el perfil sembrado, y es idempotente
  (re-cálculo no duplica).

### 7.9 Estado de implementación (2026-06-16)

**HECHO y VERIFICADO** (slice completo, como M04; `npm run build` + `npm test` + `npm run build:web` verdes):

- ✅ `packages/carbon-engine` — `computeCarbonFootprint` puro + 10 unit `TC-CO2-003..010`.
- ✅ `packages/data-collector` — `redata.ts` (`parseGenerationMix`, `composeCo2Factor`, `genMixToCo2Point`,
  `fetchGenerationMix`) + `emissionCoefficients.ts` + `createRedataHttp`; tests `TC-CO2-001/002` (+ parse/fetch).
- ✅ `apps/api` — `carbonData.ts`, `carbonIngestion.ts` (ingesta on-demand `co2_factor`), `carbonService.ts`
  (idempotente por `supplyId+rango`), `resolvers/carbon.ts`, typeDefs, holders en `runtime.ts`, error
  `CO2_NO_FACTOR_DATA`; 9 integración `TC-CO2-011..015`.
- ✅ Prisma — modelos `CarbonReport`/`CarbonReportLine` + relación inversa en `Supply` (en `schema.prisma`).
- ✅ Demo — `demoCarbonDataSource.ts` + delegados y seed `carbon-demo-30td` en `store.ts`; bootstrap real
  (Flux + REData on-demand, `REDATA_URL`) y demo.
- ✅ Front — ruta `/huella` (`carbon.component.ts`) + entrada "Huella" en topbar.

**PENDIENTE** (deuda consciente, no olvido):

1. ⚠️ **Calibrar los coeficientes de emisión** (`emissionCoefficients.ts`) con la fuente oficial vigente
   (MITECO/REE). Hoy son **valores de partida marcados `TODO`**: las cifras de CO₂ **no** son defendibles
   para reporting CSRD hasta calibrarlas.
2. **Migración Prisma + validación contra Postgres/InfluxDB reales** — transversal M01–M05 (el repo nunca ha
   corrido contra DBs reales). Modelos añadidos a `schema.prisma`, `prisma migrate` sin ejecutar.
3. **Sin worker cron de `co2_factor`** — ingesta on-demand en v1; el job periódico (análogo al PVPC) queda
   como mejora futura.
4. **Sin test de front automatizado** para `/huella` (no hay infra karma/jasmine cableada; verificación manual).

---

## 8. M06 — Simulación de autoconsumo solar

Estima qué pasaría si el cliente instalara una planta fotovoltaica: cruza la **producción solar** de
PVGIS con la **curva real de consumo** del cliente (`hourly_consumption`) para calcular, hora a hora,
**autoconsumo** y **excedentes**, y de ahí los ratios de autoconsumo/cobertura, el **ahorro anual** y el
**payback**. Es el **diferenciador**: usa la curva **real** del cliente, no perfiles sintéticos de
consumo como los simuladores ligeros del mercado. Como M01/M02/M04/M05, el cálculo puro vive en un
módulo nuevo `packages/solar-engine` (sin I/O); como M04/M05, **no hay job ni estado**: simulación bajo
demanda.

### 8.0 Decisiones de diseño (premisas de este módulo)

> **PVGIS da agregados mensuales — la producción horaria se *reparte*.** El mock (y el endpoint real)
> `/api/v5_2/PVcalc` devuelve producción **mensual/anual** (`outputs.monthly.fixed[].E_m`,
> `outputs.totals.fixed.E_y`), **no** serie horaria. Para el cruce hora a hora, el `E_m` de cada mes se
> reparte entre las horas con un **perfil solar intradía determinista** (campana entre orto y ocaso,
> longitud de día según el mes). El cruce `min(prod_h, consumo_h)` usa la curva de consumo **real** —
> ahí está el diferenciador, no en la forma de la producción. *(Mejora futura: el endpoint PVGIS
> `seriescalc` da serie horaria real de un año meteorológico tipo; requeriría ampliar el mock y mapear
> el año tipo a las fechas del cliente. Fuera de v1.)*

> **Modelo económico — coste evitado + excedentes; payback simple.** El ahorro tiene dos componentes:
> `autoconsumo_h × eurPerKwh_h` (coste de energía **evitado**, idéntico al término de energía de M01,
> §3.4) + `excedente_h × precioCompensación` (compensación simplificada de excedentes, el mismo
> mecanismo que M01 ya contempla). El `payback = CAPEX / ahorro_anual`, con `CAPEX = kWp × €/kWp`
> (`costPerKwp` es input, **default 1000 €/kWp**). Si `ahorro_anual ≤ 0`, `paybackYears = null`. La
> composición del precio se hace en el servicio (reutilizando M01) y se pasa al engine ya compuesta.

> **PVGIS se cachea por parámetros (no repetir llamadas).** Una `SolarSimulation` se identifica por
> `(supplyId, lat, lon, kwp, lossPct, tilt, azimuth)`. Recalcular con los mismos parámetros devuelve la
> simulación cacheada (idempotente); cambiar cualquier parámetro genera otra. Evita llamar a PVGIS de
> más.

1. **Cruce horario.** Para cada hora: `autoconsumo_h = min(produccion_h, consumo_h)`,
   `excedente_h = max(0, produccion_h − consumo_h)`. La energía de red evitada es el autoconsumo; el
   excedente se vierte (compensado).

2. **Periodo de análisis.** Por defecto, los **últimos 12 meses** de curva disponible. La producción de
   PVGIS es un **año meteorológico medio** (no de fechas concretas): se reparte por **mes del año** sobre
   ese periodo. El resultado es, por construcción, una **estimación anual** representativa.

3. **Calidad de dato (gaps).** Horas de consumo con `gap=true` se usan igualmente (es una simulación,
   no facturación); se documenta como limitación. No bloquea.

### 8.0bis Prerrequisitos de implementación

- **Nuevo paquete `packages/solar-engine`**: función pura `simulateSolar(input)` + utilidades. Mismo
  patrón que `carbon-engine`/`kpi-engine`: sin Prisma, sin InfluxDB, 100 % testeable. **No conoce husos,
  tarifas ni el perfil intradía**: recibe las series horarias (consumo, producción ya repartida, precio
  ya compuesto) y los parámetros económicos; el reparto `E_m`→horas, la hora local y la composición del
  precio los hace el servicio.
- **Nuevo adaptador `packages/data-collector/src/pvgis.ts`**: `fetchPvProduction(http, params)` (llama a
  `/api/v5_2/PVcalc` con `lat`, `lon`, `peakpower`, `loss`, `angle`=tilt, `aspect`=azimuth) → devuelve
  `{ monthly: number[12] (E_m), annual: number (E_y) }`. Cliente HTTP PVGIS en `http.ts` (sin auth).
  Exportado en `index.ts`.
- **Nuevo modelo Prisma** `SolarSimulation` + relación inversa en `Supply`. Como en M01–M05, **no hay
  migración aplicada**; se añade a `schema.prisma`. En tests, cliente mockeado.
- **Data source** `SolarDataSource` inyectable: real = PVGIS (producción mensual) + Flux InfluxDB
  (`hourly_consumption` + `pvpc_price`) + maestros de energía PostgreSQL (composición de M01); demo =
  generador determinista. Se inyecta vía `runtime.ts` (`setSolarDataSource`/`getSolarDataSource`).
- **Variable de entorno** `PVGIS_URL` (default `http://localhost:3004`, ya en §1.2). Sin nueva
  dependencia de front.
- **Patrón de tests**: Vitest; mock de Prisma con `vi.hoisted` (no `vitest-mock-extended`, ver §9.3).
- **Sin worker**: M06 es on-demand por simulación (PVGIS no es serie temporal periódica).

### 8.1 Fuentes de datos

| Fuente | Endpoint / origen | Dato obtenido | Uso en M06 |
|--------|-------------------|---------------|------------|
| **PVGIS** | `GET /api/v5_2/PVcalc` (`lat`, `lon`, `peakpower`, `loss`, `angle`, `aspect`) | Producción **mensual** (`outputs.monthly.fixed[].E_m`) y **anual** (`outputs.totals.fixed.E_y`) | Producción solar (repartida a horas en el servicio) |
| InfluxDB | measurement `hourly_consumption` (`kwh`) | Curva horaria real del cliente | Consumo por hora (cruce `min`) |
| InfluxDB | measurement `pvpc_price` | Precio horario PVPC | Componente del `eurPerKwh` (coste evitado) |
| PostgreSQL | `TollRate` / `ChargeRate` (tipo `ENERGY`, vigentes) | Peaje y cargo de energía | Componentes del `eurPerKwh` (idéntico a M01/M04) |

> **Sin ingesta nueva en InfluxDB**: M06 lee `hourly_consumption` y `pvpc_price` (ya de M01) y obtiene la
> producción de PVGIS bajo demanda, cacheándola en `SolarSimulation` (Prisma), no en InfluxDB.
>
> **Rango**: últimos 12 meses de curva disponible (default). Si no hay curva → `NO_CONSUMPTION_DATA`.

### 8.2 Modelos Prisma

```prisma
// ─── Simulación de autoconsumo solar (M06) ───────────────────────────────────

model SolarSimulation {
  id                     String   @id @default(uuid())
  supplyId               String
  supply                 Supply   @relation(fields: [supplyId], references: [id])
  // Parámetros de entrada (clave de caché)
  lat                    Float
  lon                    Float
  kwp                    Float    // potencia pico instalada
  lossPct                Float    @default(14)
  tilt                   Float    @default(35)   // inclinación (PVGIS `angle`)
  azimuth                Float    @default(0)    // orientación (PVGIS `aspect`)
  costPerKwp             Float    @default(1000) // €/kWp para el CAPEX
  // Periodo de consumo analizado
  rangeStart             DateTime
  rangeEnd               DateTime
  // Resultados
  annualProductionKwh    Float
  monthlyProductionJson  String   // JSON: number[12] (kWh/mes)
  annualSelfConsumptionKwh Float
  annualSurplusKwh       Float
  selfConsumptionRatio   Float    // autoconsumo / producción
  coverageRatio          Float    // autoconsumo / consumo
  annualSavingEur        Float
  paybackYears           Float?   // CAPEX / ahorro; null si ahorro ≤ 0
  computedAt             DateTime @default(now())
  @@unique([supplyId, lat, lon, kwp, lossPct, tilt, azimuth])  // caché por parámetros
}
```

> **Cambios en `Supply`**: añadir la relación inversa `solarSimulations SolarSimulation[]`. No se
> modifica ningún otro modelo de M01–M05.

> **Caché**: la simulación con los mismos parámetros devuelve la fila existente (no vuelve a llamar a
> PVGIS). `monthlyProductionJson` guarda los 12 valores mensuales como texto (la serie para el gráfico).

### 8.3 Esquema InfluxDB

M06 **no define measurements nuevos**. Lee `hourly_consumption` (`kwh`) y `pvpc_price` (§3.3). La
producción de PVGIS es agregado mensual que entra por GraphQL/cache Prisma, no serie en InfluxDB. La
asignación de `period` (para casar peaje/cargo de energía) y la hora local (para repartir `E_m` por mes y
por hora del día) usan el mismo calendario tarifario de la ingesta (§3.3).

### 8.4 Algoritmo de cálculo — paso a paso

El cálculo puro vive en `packages/solar-engine` (`simulateSolar`): sin I/O. El servicio obtiene la
producción mensual de PVGIS, la **reparte a horas** (perfil solar), compone `eurPerKwh` (vía
`SolarDataSource`, reutilizando M01) y persiste la `SolarSimulation`.

#### Responsabilidad del servicio / data source (construcción de inputs)

| Campo del input | Cómo lo construye el servicio / data source |
|-----------------|---------------------------------------------|
| `hours[]` | por cada hora `[rangeStart, rangeEnd)`: `consumptionKwh` de `hourly_consumption`; `productionKwh` = `E_m[mes]` repartido con el perfil solar intradía (campana orto–ocaso, hora local Madrid); `eurPerKwh = pvpc_h + tollEnergy[p] + chargeEnergy[p]` (composición de M01) |
| `surplusCompensationEurPerKwh` | precio de compensación simplificada de excedentes (mismo que M01, §3.4) |
| `capexEur` | `kwp × costPerKwp` |

> **Reparto `E_m` → horas (servicio)**: para cada día del mes, `E_m / díasDelMes` se distribuye entre las
> horas de luz con un peso `w_h` (perfil tipo `max(0, sin(π·(h−orto)/(ocaso−orto)))` normalizado a 1 por
> día). Determinista, dependiente solo del mes y la latitud (longitud del día). El engine recibe la
> serie ya repartida.

> Validaciones **antes** de invocar al engine: `SOLAR_INVALID_PARAMS` (lat∉[−90,90], lon∉[−180,180],
> `kwp ≤ 0`, `lossPct∉[0,100]`), `SUPPLY_NOT_FOUND`, `BACKFILL_*` (§3.5), `NO_CONSUMPTION_DATA` (sin
> curva), `PVGIS_UNAVAILABLE` (PVGIS no responde y no hay caché).

#### Interfaz del solar-engine

```typescript
// ─── Input ──────────────────────────────────────────────────────────────────

interface SolarHour {
  ts: string;          // ISO UTC
  month: string;       // "YYYY-MM" local (para los buckets mensuales)
  consumptionKwh: number;
  productionKwh: number;  // E_m repartido a esta hora (perfil solar)
  eurPerKwh: number;      // pvpc + peajeE[p] + cargoE[p], ya compuesto (idéntico a M01)
}

interface SolarInput {
  hours: SolarHour[];                  // ordenado por ts, cubre el rango
  surplusCompensationEurPerKwh: number;
  capexEur: number;                    // kwp × costPerKwp
}

// ─── Output ─────────────────────────────────────────────────────────────────

interface SolarMonthBucket {
  key: string; monthStart: string;
  productionKwh: number; selfConsumptionKwh: number; surplusKwh: number;
}

interface SolarResult {
  months: SolarMonthBucket[];          // ordenados por monthStart (evolución)
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number;        // autoconsumo / producción
  coverageRatio: number;               // autoconsumo / consumo
  annualSavingEur: number;
  paybackYears: number | null;         // capex / ahorro; null si ahorro ≤ 0
}

function simulateSolar(input: SolarInput): SolarResult;
```

#### Paso 1 — Autoconsumo y excedente por hora

```
para cada hora h:
  autoconsumo_h = min(h.productionKwh, h.consumptionKwh)
  excedente_h   = max(0, h.productionKwh − h.consumptionKwh)
  ahorro_h      = autoconsumo_h * h.eurPerKwh + excedente_h * surplusCompensationEurPerKwh
```

#### Paso 2 — Agregación mensual

Por bucket `month`: `productionKwh = Σ`, `selfConsumptionKwh = Σ autoconsumo`, `surplusKwh = Σ excedente`.

#### Paso 3 — Totales, ratios y ahorro

```
annualProductionKwh      = Σ productionKwh
annualSelfConsumptionKwh = Σ autoconsumo
annualSurplusKwh         = Σ excedente
selfConsumptionRatio     = annualSelfConsumptionKwh / annualProductionKwh
coverageRatio            = annualSelfConsumptionKwh / Σ consumptionKwh
annualSavingEur          = Σ ahorro_h
```

#### Paso 4 — Payback simple

```
paybackYears = annualSavingEur > 0 ? capexEur / annualSavingEur : null
```

#### Notas de precisión y redondeo

- Mismo criterio que §3.4 / §4.4 / §5.4 / §6.4 / §7.4: **sin redondeo intermedio**; el engine nunca
  redondea. Cruce, ahorro, ratios y payback en doble precisión; el redondeo es de presentación.
- Tests de kWh y € con tolerancia `±0.001`; ratios con `±0.0001`.

### 8.5 Esquema GraphQL

```graphql
type SolarMonth {
  monthKey:           String!
  monthStart:         String!   # ISO 8601 UTC
  productionKwh:      Float!
  selfConsumptionKwh: Float!
  surplusKwh:         Float!
}

type SolarSimulation {
  id:                       ID!
  supplyId:                 String!
  lat:                      Float!
  lon:                      Float!
  kwp:                      Float!
  lossPct:                  Float!
  tilt:                     Float!
  azimuth:                  Float!
  costPerKwp:               Float!
  rangeStart:               String!
  rangeEnd:                 String!
  annualProductionKwh:      Float!
  annualSelfConsumptionKwh: Float!
  annualSurplusKwh:         Float!
  selfConsumptionRatio:     Float!
  coverageRatio:            Float!
  annualSavingEur:          Float!
  paybackYears:             Float          # null si ahorro ≤ 0
  computedAt:               String!
  months:                   [SolarMonth!]! # ordenados por monthStart (evolución)
}

input SimulateSolarInput {
  cups:       String!
  lat:        Float!
  lon:        Float!
  kwp:        Float!
  lossPct:    Float    # default 14
  tilt:       Float    # default 35
  azimuth:    Float    # default 0
  costPerKwp: Float    # default 1000
}

extend type Query {
  solarSimulation(id: ID!): SolarSimulation
  solarSimulations(supplyId: String!): [SolarSimulation!]!
}

extend type Mutation {
  # Simula (o devuelve la simulación cacheada por parámetros). Llama a PVGIS on-demand si no hay caché.
  simulateSolar(input: SimulateSolarInput!): SolarSimulation!
}
```

**Errores esperados** (formato GraphQL estándar con `extensions.code`):

| Código | Condición |
|--------|-----------|
| `SOLAR_INVALID_PARAMS` | `lat`/`lon` fuera de rango, `kwp ≤ 0`, `lossPct ∉ [0,100]` |
| `SUPPLY_NOT_FOUND` | El CUPS no existe en PostgreSQL |
| `BACKFILL_PENDING` / `BACKFILL_RUNNING` / `BACKFILL_FAILED` | El histórico aún no está disponible (§3.5) |
| `NO_CONSUMPTION_DATA` | No hay curva (`hourly_consumption`) en el rango |
| `PVGIS_UNAVAILABLE` | PVGIS no responde y no hay simulación cacheada con esos parámetros |
| `SOLAR_SIMULATION_NOT_FOUND` | `solarSimulation(id)` — *devuelve `null`, no error* (consistente con `alert(id)`) |

> **Autorización** (§2.2): leer (`solarSimulation`, `solarSimulations`) → `assertSupplyAccess`.
> Escribir (`simulateSolar`) → rol de escritura (DOMINION/ADMIN/GESTOR); `USUARIO` solo lectura.

### 8.6 Casos de test — contrato de implementación

> Los tests del `solar-engine` y del reparto `E_m`→horas son unitarios (sin I/O). Los del resolver/
> servicio son de integración con Prisma, InfluxDB y PVGIS mockeados. Nomenclatura `TC-SOL-NNN` (§9.1).

#### TC-SOL-001 — Autoconsumo = min(prod, consumo) — Unit

`prod=[2,5]`, `consumo=[3,3]` → `autoconsumo=[2,3]`, `excedente=[0,2]`. Verifica el cruce horario.

#### TC-SOL-002 — Excedente = max(0, prod − consumo) — Unit

Producción nocturna 0 → autoconsumo 0, excedente 0; producción > consumo → excedente positivo.

#### TC-SOL-003 — Ratio de autoconsumo — Unit

`Σautoconsumo=5`, `Σproducción=10` → `selfConsumptionRatio=0.5`.

#### TC-SOL-004 — Ratio de cobertura — Unit

`Σautoconsumo=5`, `Σconsumo=20` → `coverageRatio=0.25`.

#### TC-SOL-005 — Ahorro = coste evitado + compensación — Unit

`autoconsumo=4 @0.20 €/kWh` + `excedente=2 @0.05 €/kWh` → `ahorro = 0.8 + 0.1 = 0.9`. Verifica los dos
componentes.

#### TC-SOL-006 — Payback simple — Unit

`capex=10000`, `ahorro_anual=2000` → `paybackYears=5`.

#### TC-SOL-007 — Payback null si ahorro ≤ 0 — Unit

`ahorro_anual=0` → `paybackYears=null` (sin división por cero).

#### TC-SOL-008 — Agregación mensual y orden — Unit

Buckets `month` con `production/self/surplus = Σ`; `months` ordenados por `monthStart`.

#### TC-SOL-009 — Reparto E_m → horas (perfil solar) — Unit

`E_m` repartido a las horas de un mes: `Σ producción_h del mes = E_m` (conserva la energía); producción
**0 de noche** y máxima al mediodía. Verifica la campana y la conservación.

#### TC-SOL-010 — simulateSolar calcula y persiste — Integration

Parámetros válidos + PVGIS + curva → `SolarSimulation` con `months` y ratios. Sin curva →
`NO_CONSUMPTION_DATA`.

#### TC-SOL-011 — Caché por parámetros (idempotente) — Integration

Segunda llamada con los **mismos** parámetros → devuelve la fila cacheada **sin** volver a llamar a
PVGIS (por `@@unique`). Cambiar `kwp` → nueva simulación + nueva llamada a PVGIS.

#### TC-SOL-012 — Parámetros inválidos → SOLAR_INVALID_PARAMS — Integration

`lat=120`, `kwp=0` o `lossPct=150` → `SOLAR_INVALID_PARAMS` (no llama a PVGIS, no persiste).

#### TC-SOL-013 — PVGIS caído sin caché → PVGIS_UNAVAILABLE — Integration

PVGIS responde error y no hay simulación cacheada → `PVGIS_UNAVAILABLE`.

#### TC-SOL-014 — Reutiliza la composición de precio de M01 — Integration

El `eurPerKwh` por hora del ahorro coincide con `pvpc_h + tollEnergy[p] + chargeEnergy[p]` (mismos
maestros que M01/M04).

#### TC-SOL-015 — Backfill no listo → BACKFILL_* — Integration

`backfillStatus = PENDING/RUNNING/FAILED` → `BACKFILL_*` (mismo contrato que §3.7 / … / §7.6).

#### TC-SOL-016 — Consultas y autorización — Integration

`solarSimulations` filtra por supply; `solarSimulation(id)` inexistente → `null`. `USUARIO` sobre
`simulateSolar` → `FORBIDDEN`; `ADMIN` de otro cliente → `FORBIDDEN` (reglas §2.2).

### 8.7 Front (apps/web) — no normativo en lo visual

> Como en M02–M05, el detalle visual no es contrato; el **flujo de datos** **sí** lo es.

- **Topbar**: nueva entrada **Solar** junto a Pre-factura / Optimización / Alertas / KPI / Huella.
- **Ruta** `/solar` (protegida por `authGuard`) → `SolarComponent`. Reutiliza `GraphqlService`.
- **Entradas**: CUPS + `lat`/`lon` + `kWp` + pérdidas (%) + (opcional) inclinación/orientación +
  `€/kWp`. Defaults: pérdidas 14 %, inclinación 35°, orientación 0° (sur), 1000 €/kWp.
- **Flujo**: botón **Simular** → `simulateSolar(input)`.
- **Resultado**: producción anual + **gráfico mensual** (producción vs autoconsumo vs excedente),
  **ratios** (autoconsumo / cobertura), **ahorro anual €** y **payback** (años, o "no rentable" si
  `null`). Mensaje de que usa la **curva real** del cliente.

### 8.8 Modo demo (para probar `/solar` sin DBs reales)

Mismo mecanismo de holders que M01–M05 (`runtime.ts`), arrancando con `npm run demo`:

- **`makeDemoSolarDataSource()`**: devuelve una **producción mensual determinista** (forma estacional:
  más en verano, menos en invierno) y una curva horaria determinista (`hourly_consumption` + `pvpc_price`
  compuesto), sin `Math.random()`. En `index.ts` se inyecta la fuente real (PVGIS + Flux + maestros); en
  `demo.ts`, `makeDemoSolarDataSource()`.
- **`SolarSimulation` demo sembrada** en el store en memoria (`demo/store.ts`): una simulación con ratios
  y payback realistas para enseñar la pantalla al entrar sin simular.
- **Delegado Prisma** en `store.ts` para `solarSimulation`, sembrado en ambos CUPS demo.
- **Resultado esperado documentado**: en demo, `simulateSolar(...)` produce una `SolarSimulation` con
  `months` (12), `selfConsumptionRatio`/`coverageRatio` en (0,1), `annualSavingEur > 0` y `paybackYears`
  finito; la segunda llamada con los mismos parámetros devuelve la cacheada (idempotente).

---

## 9. Convenciones de test

> Sección transversal. Se replica la estructura `§N.X Casos de test` en cada módulo M02–M06 siguiendo estas mismas convenciones.

### 9.1 Nomenclatura

`TC-{MOD}-{NNN}`

| MOD | Módulo |
|-----|--------|
| `AUTH` | Autenticación y autorización (transversal) |
| `PRE`  | M01 — Pre-factura automática |
| `OPT`  | M02 — Optimización de potencia contratada |
| `ALT`  | M03 — Alertas y detección de anomalías |
| `KPI`  | M04 — KPI de coste por unidad producida |
| `CO2`  | M05 — Huella de carbono |
| `SOL`  | M06 — Simulación de autoconsumo solar |

### 9.2 Capas

| Capa | Descripción | I/O externo |
|------|-------------|-------------|
| **Unit** | Función pura, sin I/O | Ninguno |
| **Integration** | Resolver/servicio con Prisma e InfluxDB mockeados | Mock HTTP/DB |
| **E2E** | Stack real contra `lynx-lite-mocks` | Mocks en localhost |

Cada caso de test declara su capa en el campo **Módulo** (`— Unit` / `— Integration` / `— E2E`).

Los tests de M01 y M02 son Unit e Integration. No se definen tests E2E hasta que exista frontend.

### 9.3 Herramientas

- **Unit / Integration**: Vitest
- **Fixtures**: datos sintéticos reutilizables en `apps/api/test/fixtures/`
- **Mocks HTTP**: `vi.spyOn` sobre los adaptadores de ingesta
- **Mock DB**: cliente Prisma mockeado con `vi.hoisted` (**no** usar `vitest-mock-extended`); cliente InfluxDB mockeado a nivel de módulo

### 9.4 Cobertura mínima por módulo

- pricing-engine (o equivalente de cálculo puro): 100 % de ramas del algoritmo
- Resolvers GraphQL: todos los errores definidos en `§N.5 Errores esperados`
- Adaptadores de ingesta: conversiones de unidad + comportamiento ante respuesta 429

---

*Fin de SPECS.md — pendiente de aprobación antes de continuar al Paso 2.*
