// SDL completo: autenticación/usuarios (SPECS §2.6) + M01 pre-factura (§3.5).
export const typeDefs = /* GraphQL */ `
  # ─── Enums ──────────────────────────────────────────────────────────────────
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

  # ─── Usuarios y auth ────────────────────────────────────────────────────────
  type AuthPayload {
    token: String!
    user: User!
  }

  type User {
    id: ID!
    email: String!
    name: String!
    role: UserRole!
    clientId: String
    supplyId: String
    createdAt: String!
  }

  input LoginInput {
    email: String!
    password: String!
  }

  input CreateUserInput {
    email: String!
    password: String!
    name: String!
    role: UserRole!
    clientId: String
    supplyId: String
  }

  input UpdateUserInput {
    name: String
    password: String
    role: UserRole
  }

  # ─── Suministro ─────────────────────────────────────────────────────────────
  type Supply {
    id: ID!
    cups: String!
    clientId: String!
    address: String
    tariff: Tariff!
    backfillStatus: BackfillStatus!
    createdAt: String!
  }

  input CreateSupplyInput {
    cups: String!
    clientId: String!
    address: String
    tariff: Tariff!
  }

  # ─── Pre-factura ────────────────────────────────────────────────────────────
  type PreInvoiceLine {
    concept: String!
    period: Int
    quantity: Float!
    unit: String!
    unitPrice: Float!
    amount: Float!
    sortOrder: Int!
  }

  type PreInvoice {
    id: ID!
    supplyId: String!
    periodFrom: String!
    periodTo: String!
    tariff: Tariff!
    powerTerm: Float!
    energyTerm: Float!
    excessPower: Float!
    reactiveEnergy: Float
    surplusCompensation: Float
    meterRental: Float!
    subtotal: Float!
    ieeAmount: Float!
    vatAmount: Float!
    total: Float!
    gapHoursCount: Int!
    gapPeriodsJson: String
    lines: [PreInvoiceLine!]!
    createdAt: String!
  }

  input PreInvoiceInput {
    cups: String!
    periodFrom: String!
    periodTo: String!
  }

  # ─── Optimización de potencia (M02) ───────────────────────────────────────────
  type PowerOptimizationPeriod {
    period: Int!
    currentPower: Float!
    optimalPower: Float!
    p99Power: Float!
    observedMax: Float!
    diagnosis: String! # "OK" | "OVERSIZED" | "UNDERSIZED"
    marginPct: Float!
  }

  type PowerOptimization {
    id: ID!
    supplyId: String!
    tariff: Tariff!
    analysisFrom: String!
    analysisTo: String!
    granularity: String! # "hourly" | "quarter"
    upliftFactor: Float!
    sampleCount: Int!
    fixedSaving: Float!
    excessSaving: Float!
    annualSaving: Float!
    recommendChange: Boolean!
    changeAllowed: Boolean!
    changeBlockedUntil: String # ISO; null si changeAllowed
    periods: [PowerOptimizationPeriod!]!
    createdAt: String!
  }

  input PowerOptimizationInput {
    cups: String!
    analysisFrom: String!
    analysisTo: String!
  }

  # ─── Alertas y detección de anomalías (M03) ───────────────────────────────────
  type Alert {
    id: ID!
    supplyId: String!
    type: String! # "ZSCORE" | "PHANTOM" | "LIMIT" | "ESTIMATED"
    severity: String! # "INFO" | "WARNING" | "CRITICAL"
    status: String! # "NEW" | "ACKNOWLEDGED" | "DISMISSED"
    period: Int!
    windowStart: String! # ISO 8601 UTC
    windowEnd: String!
    observedValue: Float!
    expectedValue: Float
    deviation: Float
    message: String!
    detectedAt: String!
    acknowledgedBy: String
    acknowledgedAt: String
  }

  type InactivityWindow {
    days: [Int!]!
    from: String!
    to: String!
  }

  type AlertConfig {
    id: ID!
    supplyId: String!
    enabled: Boolean!
    sensitivity: String! # "CONSERVADOR" | "EQUILIBRADO" | "AGRESIVO"
    enabledTypes: [String!]!
    limitThresholdPct: Float!
    phantomThresholdKwh: Float!
    inactivityWindows: [InactivityWindow!]!
    updatedAt: String!
  }

  input InactivityWindowInput {
    days: [Int!]!
    from: String!
    to: String!
  }

  input AlertConfigInput {
    cups: String!
    enabled: Boolean
    sensitivity: String
    enabledTypes: [String!]
    limitThresholdPct: Float
    phantomThresholdKwh: Float
    inactivityWindows: [InactivityWindowInput!]
  }

  input EvaluateAlertsInput {
    cups: String!
    day: String # "YYYY-MM-DD"; default = último día cerrado (D-2)
  }

  # ─── Operaciones ────────────────────────────────────────────────────────────
  type Query {
    me: User!
    users(clientId: String, supplyId: String): [User!]!
    user(id: ID!): User

    supply(id: ID!): Supply
    calculatePreInvoice(input: PreInvoiceInput!): PreInvoice!
    preInvoice(id: ID!): PreInvoice
    preInvoices(supplyId: String!, limit: Int, offset: Int): [PreInvoice!]!

    calculatePowerOptimization(input: PowerOptimizationInput!): PowerOptimization!
    powerOptimization(id: ID!): PowerOptimization
    powerOptimizations(supplyId: String!, limit: Int, offset: Int): [PowerOptimization!]!

    alerts(supplyId: String!, status: String, type: String, limit: Int, offset: Int): [Alert!]!
    alert(id: ID!): Alert
    alertConfig(supplyId: String!): AlertConfig
  }

  type Mutation {
    login(input: LoginInput!): AuthPayload!

    createUser(input: CreateUserInput!): User!
    updateUser(id: ID!, input: UpdateUserInput!): User!
    deleteUser(id: ID!): Boolean!

    requestSupply(cups: String!, address: String, tariff: Tariff!): Supply!
    approveSupply(supplyId: ID!): Supply!
    rejectSupply(supplyId: ID!): Boolean!

    createSupply(input: CreateSupplyInput!): Supply!
    savePreInvoice(input: PreInvoiceInput!): PreInvoice!
    deletePreInvoice(id: ID!): Boolean!

    savePowerOptimization(input: PowerOptimizationInput!): PowerOptimization!
    deletePowerOptimization(id: ID!): Boolean!

    saveAlertConfig(input: AlertConfigInput!): AlertConfig!
    evaluateAlerts(input: EvaluateAlertsInput!): [Alert!]!
    acknowledgeAlert(id: ID!): Alert!
    dismissAlert(id: ID!): Alert!
  }
`;
