# SPECS.md — lynx-lite

**Version**: 0.3-DRAFT  
**Fecha**: 2026-06-12  
**Estado**: Pendiente de aprobación

---

## Índice

1. [Arquitectura general](#1-arquitectura-general)
2. [Sistema de usuarios y autenticación](#2-sistema-de-usuarios-y-autenticación)
3. [M01 — Pre-factura automática](#3-m01--pre-factura-automática)
4. [M02 — Optimización de potencia contratada](#4-m02--optimización-de-potencia-contratada)
5. [Convenciones de test](#5-convenciones-de-test)

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

`uplift = (granularity === 'hourly') ? 1.05 : 1.00`.

Para cada power period `Pi` activo según la tarifa (P1–P2 en 2.0TD; P1–P6 en 3.0TD):

```
p99[Pi]        = percentil(99, powerSamplesByPeriod[Pi])
optimalRaw[Pi] = p99[Pi] × uplift
```

> El percentil se calcula por **interpolación lineal** sobre la muestra ordenada (método
> "linear" / R-7, el de `numpy.percentile` por defecto). Los tests fijan el método para
> evitar ambigüedad entre implementaciones.

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
> integración con Prisma e InfluxDB mockeados. Nomenclatura `TC-OPT-NNN` (§5.1).

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

---

## 5. Convenciones de test

> Sección transversal. Se replica la estructura `§N.X Casos de test` en cada módulo M02–M06 siguiendo estas mismas convenciones.

### 5.1 Nomenclatura

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

### 5.2 Capas

| Capa | Descripción | I/O externo |
|------|-------------|-------------|
| **Unit** | Función pura, sin I/O | Ninguno |
| **Integration** | Resolver/servicio con Prisma e InfluxDB mockeados | Mock HTTP/DB |
| **E2E** | Stack real contra `lynx-lite-mocks` | Mocks en localhost |

Cada caso de test declara su capa en el campo **Módulo** (`— Unit` / `— Integration` / `— E2E`).

Los tests de M01 y M02 son Unit e Integration. No se definen tests E2E hasta que exista frontend.

### 5.3 Herramientas

- **Unit / Integration**: Vitest
- **Fixtures**: datos sintéticos reutilizables en `apps/api/test/fixtures/`
- **Mocks HTTP**: `vi.spyOn` sobre los adaptadores de ingesta
- **Mock DB**: cliente Prisma mockeado con `vi.hoisted` (**no** usar `vitest-mock-extended`); cliente InfluxDB mockeado a nivel de módulo

### 5.4 Cobertura mínima por módulo

- pricing-engine (o equivalente de cálculo puro): 100 % de ramas del algoritmo
- Resolvers GraphQL: todos los errores definidos en `§N.5 Errores esperados`
- Adaptadores de ingesta: conversiones de unidad + comportamiento ante respuesta 429

---

*Fin de SPECS.md — pendiente de aprobación antes de continuar al Paso 2.*
