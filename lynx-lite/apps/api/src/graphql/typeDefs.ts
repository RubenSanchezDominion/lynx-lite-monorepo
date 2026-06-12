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

  # ─── Operaciones ────────────────────────────────────────────────────────────
  type Query {
    me: User!
    users(clientId: String, supplyId: String): [User!]!
    user(id: ID!): User

    supply(id: ID!): Supply
    calculatePreInvoice(input: PreInvoiceInput!): PreInvoice!
    preInvoice(id: ID!): PreInvoice
    preInvoices(supplyId: String!, limit: Int, offset: Int): [PreInvoice!]!
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
  }
`;
