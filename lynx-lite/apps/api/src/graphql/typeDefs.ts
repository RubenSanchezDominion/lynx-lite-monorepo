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

  # ─── Comparativa de suministros (M07) ─────────────────────────────────────────
  type ComparisonDelta {
    totalA: Float!
    totalB: Float!
    deltaTotal: Float!
    deltaTotalPct: Float # null si totalA = 0
    powerTermDelta: Float!
    energyTermDelta: Float!
    excessPowerDelta: Float!
    reactiveDelta: Float # null si ambos lados sin reactiva
    meterRentalDelta: Float!
    taxesDelta: Float!
    kwhA: Float!
    kwhB: Float!
    avgCostPerKwhA: Float # null si kwhA = 0
    avgCostPerKwhB: Float # null si kwhB = 0
    deltaCostPerKwh: Float # null si falta algún avgCost
    sameTariff: Boolean!
  }

  type ComparisonResult {
    a: PreInvoice!
    b: PreInvoice!
    delta: ComparisonDelta!
  }

  input ComparisonInput {
    a: PreInvoiceInput!
    b: PreInvoiceInput!
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

  # ─── KPI de coste por unidad producida (M04) ──────────────────────────────────
  type ProductionUpload {
    id: ID!
    supplyId: String!
    fileName: String!
    format: String! # "CSV" | "XLSX"
    rowCount: Int!
    rangeStart: String! # ISO 8601 UTC
    rangeEnd: String!
    uploadedAt: String!
  }

  type KpiReportLine {
    bucketKey: String!
    bucketStart: String! # ISO 8601 UTC
    units: Float!
    kwh: Float!
    costEur: Float!
    eurPerUnit: Float!
    isOutlier: Boolean!
  }

  type KpiReport {
    id: ID!
    supplyId: String!
    uploadId: String!
    granularity: String! # "SHIFT" | "DAY" | "WEEK" | "MONTH"
    rangeStart: String!
    rangeEnd: String!
    totalUnits: Float!
    totalKwh: Float!
    totalCostEur: Float!
    avgEurPerUnit: Float!
    baselineEurPerUnit: Float!
    outlierPct: Float!
    hasGaps: Boolean!
    computedAt: String!
    lines: [KpiReportLine!]! # ordenadas por bucketStart (evolución)
  }

  input ProductionRowInput {
    startTs: String! # ISO 8601 (parseado en el front a UTC)
    endTs: String!
    units: Float!
    shift: String # "M" | "T" | "N"
    line: String
    batch: String
  }

  input SubmitProductionInput {
    cups: String!
    fileName: String!
    format: String! # "CSV" | "XLSX"
    rows: [ProductionRowInput!]!
  }

  input ComputeKpiInput {
    uploadId: String!
    granularity: String # default "DAY"
    outlierPct: Float # default 0.20
  }

  # ─── Huella de carbono (M05) ──────────────────────────────────────────────────
  type CarbonReportLine {
    monthKey: String!
    monthStart: String! # ISO 8601 UTC
    kwh: Float!
    co2Kg: Float!
    factorAvg: Float! # gCO₂/kWh
    hasGaps: Boolean!
  }

  type CarbonReport {
    id: ID!
    supplyId: String!
    rangeStart: String!
    rangeEnd: String!
    totalKwh: Float!
    totalCo2Kg: Float!
    ownFactorGPerKwh: Float!
    nationalAvgFactor: Float!
    deltaPct: Float!
    hasGaps: Boolean!
    computedAt: String!
    lines: [CarbonReportLine!]! # ordenadas por monthStart (evolución)
  }

  input ComputeCarbonInput {
    cups: String!
    from: String! # ISO 8601 (inclusive)
    to: String! # ISO 8601 (exclusive)
  }

  # ─── Autoconsumo solar (M06) ──────────────────────────────────────────────────
  type SolarMonth {
    monthKey: String!
    monthStart: String! # ISO 8601 UTC
    productionKwh: Float!
    selfConsumptionKwh: Float!
    surplusKwh: Float!
  }

  type SolarSimulation {
    id: ID!
    supplyId: String!
    lat: Float!
    lon: Float!
    kwp: Float!
    lossPct: Float!
    tilt: Float!
    azimuth: Float!
    costPerKwp: Float!
    rangeStart: String!
    rangeEnd: String!
    annualProductionKwh: Float!
    annualSelfConsumptionKwh: Float!
    annualSurplusKwh: Float!
    selfConsumptionRatio: Float!
    coverageRatio: Float!
    annualSavingEur: Float!
    paybackYears: Float # null si ahorro ≤ 0
    computedAt: String!
    months: [SolarMonth!]! # ordenados por monthStart (evolución)
  }

  input SimulateSolarInput {
    cups: String!
    lat: Float!
    lon: Float!
    kwp: Float!
    lossPct: Float # default 14
    tilt: Float # default 35
    azimuth: Float # default 0
    costPerKwp: Float # default 1000
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

    calculateComparison(input: ComparisonInput!): ComparisonResult!

    calculatePowerOptimization(input: PowerOptimizationInput!): PowerOptimization!
    powerOptimization(id: ID!): PowerOptimization
    powerOptimizations(supplyId: String!, limit: Int, offset: Int): [PowerOptimization!]!

    alerts(supplyId: String!, status: String, type: String, limit: Int, offset: Int): [Alert!]!
    alert(id: ID!): Alert
    alertConfig(supplyId: String!): AlertConfig

    productionUploads(supplyId: String!): [ProductionUpload!]!
    kpiReport(id: ID!): KpiReport
    kpiReports(supplyId: String!): [KpiReport!]!

    carbonReport(id: ID!): CarbonReport
    carbonReports(supplyId: String!): [CarbonReport!]!

    solarSimulation(id: ID!): SolarSimulation
    solarSimulations(supplyId: String!): [SolarSimulation!]!
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

    submitProductionData(input: SubmitProductionInput!): ProductionUpload!
    computeKpi(input: ComputeKpiInput!): KpiReport!

    computeCarbonFootprint(input: ComputeCarbonInput!): CarbonReport!

    simulateSolar(input: SimulateSolarInput!): SolarSimulation!
  }
`;
