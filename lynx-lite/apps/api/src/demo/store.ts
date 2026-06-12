import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';

// Store en memoria que imita el subconjunto de PrismaClient usado por resolvers y
// servicios. SOLO para el modo demo (src/demo.ts): sin Postgres. Ignora los filtros
// de vigencia por fecha — los maestros sembrados valen para cualquier período.

type Row = Record<string, unknown>;

// Valores de tarifas alineados con prisma/seed.ts (mismos números que los TC).
const TOLL_POWER: Record<string, Record<number, number>> = {
  T_2_0TD: { 1: 0.115327, 2: 0.002572 },
  T_3_0TD: { 1: 0.115327, 2: 0.082748, 3: 0.024894, 4: 0.024894, 5: 0.003695, 6: 0.002572 },
};
const TOLL_ENERGY: Record<string, Record<number, number>> = {
  T_2_0TD: { 1: 0.007215, 2: 0.004860, 3: 0.000841 },
  T_3_0TD: { 1: 0.009518, 2: 0.006872, 3: 0.003558, 4: 0.003558, 5: 0.002122, 6: 0.000841 },
};
const CHARGE_POWER: Record<string, Record<number, number>> = {
  T_2_0TD: { 1: 0.011000, 2: 0.001000 },
  T_3_0TD: { 1: 0.015000, 2: 0.010000, 3: 0.006000, 4: 0.006000, 5: 0.002000, 6: 0.001000 },
};
const CHARGE_ENERGY: Record<string, Record<number, number>> = {
  T_2_0TD: { 1: 0.003000, 2: 0.002000, 3: 0.001000 },
  T_3_0TD: { 1: 0.005000, 2: 0.004000, 3: 0.003000, 4: 0.003000, 5: 0.002000, 6: 0.001000 },
};

function flattenRates(map: Record<string, Record<number, number>>, rateType: string): Row[] {
  const rows: Row[] = [];
  for (const tariff of Object.keys(map)) {
    for (const [period, eur] of Object.entries(map[tariff])) {
      rows.push({ id: randomUUID(), tariff, period: Number(period), rateType, eur });
    }
  }
  return rows;
}

export async function createInMemoryStore() {
  const now = new Date();

  const users: Row[] = [
    {
      id: randomUUID(), email: 'dominion@lynx.local', passwordHash: await bcrypt.hash('dominion', 10),
      name: 'Dominion Admin', role: 'DOMINION', clientId: null, supplyId: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'admin-demo', email: 'admin@pyme.local', passwordHash: await bcrypt.hash('admin', 10),
      name: 'Admin Pyme', role: 'ADMIN', clientId: 'client-demo', supplyId: null, createdAt: now, updatedAt: now,
    },
  ];

  const clients: Row[] = [
    { id: 'client-demo', name: 'Pyme Demo S.L.', vatNumber: 'B12345678', email: 'demo@pyme.local', createdAt: now, updatedAt: now },
  ];

  const supplies: Row[] = [
    {
      id: 'supply-20td', cups: 'ES0031000000000002JN', clientId: 'client-demo', address: 'Calle Mayor 15, Zaragoza',
      tariff: 'T_2_0TD', status: 'ACTIVE', requestedBy: null, backfillStatus: 'DONE', createdAt: now, updatedAt: now,
    },
    {
      id: 'supply-30td', cups: 'ES0031000000000001JN', clientId: 'client-demo', address: 'Polígono Malpica, Nave 47, Zaragoza',
      tariff: 'T_3_0TD', status: 'ACTIVE', requestedBy: null, backfillStatus: 'DONE', createdAt: now, updatedAt: now,
    },
  ];

  const contracts: Row[] = [
    {
      id: randomUUID(), supplyId: 'supply-20td', validFrom: new Date('2020-01-01'), validTo: null,
      contractedPowerP1: 10, contractedPowerP2: 10, contractedPowerP3: null, contractedPowerP4: null,
      contractedPowerP5: null, contractedPowerP6: null, modePowerControl: 'ICP', hasSurplus: false, createdAt: now,
    },
    {
      id: randomUUID(), supplyId: 'supply-30td', validFrom: new Date('2020-01-01'), validTo: null,
      contractedPowerP1: 50, contractedPowerP2: 50, contractedPowerP3: 50, contractedPowerP4: 50,
      contractedPowerP5: 50, contractedPowerP6: 50, modePowerControl: 'MAXIMETRO', hasSurplus: false, createdAt: now,
    },
  ];

  const tollRates: Row[] = [...flattenRates(TOLL_POWER, 'POWER'), ...flattenRates(TOLL_ENERGY, 'ENERGY')];
  const chargeRates: Row[] = [...flattenRates(CHARGE_POWER, 'POWER'), ...flattenRates(CHARGE_ENERGY, 'ENERGY')];
  const ieeRates: Row[] = [{ id: randomUUID(), rate: 0.0511269632 }];
  const vatRates: Row[] = [{ id: randomUUID(), rate: 0.21 }];
  const meterRentalRates: Row[] = [
    { id: randomUUID(), tariff: 'T_2_0TD', eurPerDay: 0.026114 },
    { id: randomUUID(), tariff: 'T_3_0TD', eurPerDay: 0.039660 },
  ];
  const reactiveEnergyRates: Row[] = [
    { id: randomUUID(), tier: 1, eur: 0.041554 },
    { id: randomUUID(), tier: 2, eur: 0.062332 },
  ];

  const preInvoices: Row[] = [];

  // Helpers de delegate.
  const findUniqueBy = (rows: Row[], where: Row): Row | null => {
    const keys = Object.keys(where);
    return rows.find(r => keys.every(k => r[k] === where[k])) ?? null;
  };

  // ─── Facade tipo Prisma ──────────────────────────────────────────────────────
  return {
    user: {
      findUnique: async ({ where }: { where: Row }) => findUniqueBy(users, where),
      findMany: async ({ where = {} }: { where?: Row } = {}) =>
        users.filter(u => Object.keys(where).every(k => where[k] === undefined || u[k] === where[k])),
      create: async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), clientId: null, supplyId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = findUniqueBy(users, where);
        if (!row) throw new Error('user no encontrado');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        const i = users.findIndex(u => u.id === where.id);
        if (i >= 0) users.splice(i, 1);
        return {};
      },
    },

    supply: {
      findUnique: async ({ where }: { where: Row }) => findUniqueBy(supplies, where),
      findMany: async ({ where = {} }: { where?: Row } = {}) =>
        supplies.filter(s => Object.keys(where).every(k => where[k] === undefined || s[k] === where[k])),
      create: async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), status: 'ACTIVE', requestedBy: null, address: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        supplies.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = findUniqueBy(supplies, where);
        if (!row) throw new Error('supply no encontrado');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        const i = supplies.findIndex(s => s.id === where.id);
        if (i >= 0) supplies.splice(i, 1);
        return {};
      },
    },

    contract: {
      // Ignora filtros de fecha; devuelve el contrato del supply.
      findFirst: async ({ where }: { where: Row }) =>
        contracts.find(c => c.supplyId === where.supplyId) ?? null,
    },

    preInvoice: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = preInvoices.find(p => p.id === where.id) ?? null;
        else if (where.supplyId_periodFrom_periodTo) {
          const k = where.supplyId_periodFrom_periodTo as Row;
          row = preInvoices.find(p =>
            p.supplyId === k.supplyId &&
            (p.periodFrom as Date).getTime() === (k.periodFrom as Date).getTime() &&
            (p.periodTo as Date).getTime() === (k.periodTo as Date).getTime(),
          ) ?? null;
        }
        return row ? withIncludes(row, include, supplies) : null;
      },
      findMany: async ({ where, orderBy, take, skip }: { where: Row; include?: Row; orderBy?: Row; take?: number; skip?: number }) => {
        let list = preInvoices.filter(p => p.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).periodFrom === 'desc') {
          list = [...list].sort((a, b) => (b.periodFrom as Date).getTime() - (a.periodFrom as Date).getTime());
        }
        if (skip) list = list.slice(skip);
        if (take !== undefined) list = list.slice(0, take);
        return list.map(p => ({ ...p, lines: p.lines }));
      },
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        const lines = extractLines(data);
        const row: Row = { id: randomUUID(), createdAt: new Date(), ...stripLines(data), lines };
        preInvoices.push(row);
        return withIncludes(row, include, supplies);
      },
      update: async ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
        const row = preInvoices.find(p => p.id === where.id);
        if (!row) throw new Error('preInvoice no encontrada');
        const lines = data.lines ? extractLines(data) : (row.lines as Row[]);
        Object.assign(row, stripLines(data), { lines });
        return withIncludes(row, include, supplies);
      },
      delete: async ({ where }: { where: Row }) => {
        const i = preInvoices.findIndex(p => p.id === where.id);
        if (i >= 0) preInvoices.splice(i, 1);
        return {};
      },
    },

    preInvoiceLine: {
      deleteMany: async ({ where }: { where: Row }) => {
        const pi = preInvoices.find(p => p.id === where.preInvoiceId);
        if (pi) pi.lines = [];
        return { count: 0 };
      },
    },

    tollRate: { findMany: async ({ where }: { where: Row }) => tollRates.filter(r => r.tariff === where.tariff) },
    chargeRate: { findMany: async ({ where }: { where: Row }) => chargeRates.filter(r => r.tariff === where.tariff) },
    iEERate: { findFirst: async () => ieeRates[0] ?? null },
    vATRate: { findFirst: async () => vatRates[0] ?? null },
    meterRentalRate: { findFirst: async ({ where }: { where: Row }) => meterRentalRates.find(r => r.tariff === where.tariff) ?? null },
    reactiveEnergyRate: { findMany: async () => reactiveEnergyRates },
  };
}

// ─── utilidades de líneas anidadas (data.lines.create) ─────────────────────────
function extractLines(data: Row): Row[] {
  const linesSpec = data.lines as { create?: Row[] } | undefined;
  const created = linesSpec?.create ?? [];
  return created.map(l => ({ id: randomUUID(), ...l }));
}
function stripLines(data: Row): Row {
  const { lines, ...rest } = data;
  void lines;
  return rest;
}
function withIncludes(row: Row, include: Row | undefined, supplies: Row[]): Row {
  const out: Row = { ...row };
  if (include?.supply) out.supply = supplies.find(s => s.id === row.supplyId) ?? null;
  return out;
}
