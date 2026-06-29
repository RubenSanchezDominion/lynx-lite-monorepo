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
// tepp4-5 €/kW·día — valores oficiales Anexo II Resolución vigente 2026 (BOE-A-2025-26348),
// alineados con prisma/seed.ts. 2.0TD solo tiene 2 períodos de potencia.
const EXCESS_POWER: Record<string, Record<number, number>> = {
  T_2_0TD: { 1: 0.279426, 2: 0.005316 },
  T_3_0TD: { 1: 0.171373, 2: 0.090584, 3: 0.028721, 4: 0.021891, 5: 0.006142, 6: 0.006142 },
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
  const excessPowerRates: Row[] = [];
  for (const tariff of Object.keys(EXCESS_POWER)) {
    for (const [period, eurPerDay] of Object.entries(EXCESS_POWER[tariff])) {
      excessPowerRates.push({ id: randomUUID(), tariff, period: Number(period), eurPerDay });
    }
  }

  // M01 — pre-facturas sembradas (3 meses por suministro) para que el Dashboard (§11) muestre
  // coste último/anterior y serie mensual sin recalcular nada. Una línea de energía (unit 'kWh')
  // por factura permite derivar el consumo del periodo.
  const buildPreInvoice = (
    supplyId: string, tariff: string, month: number, total: number, kwh: number,
  ): Row => {
    const periodFrom = new Date(Date.UTC(2026, month, 1));
    const periodTo = new Date(Date.UTC(2026, month + 1, 1));
    const energyTerm = total * 0.6;
    const powerTerm = total * 0.25;
    const id = randomUUID();
    return {
      id, supplyId, periodFrom, periodTo, tariff,
      powerTerm, energyTerm, excessPower: 0, reactiveEnergy: null, surplusCompensation: null,
      meterRental: 1.2, subtotal: total / 1.21, ieeAmount: total * 0.04, vatAmount: total * 0.1736,
      total, gapHoursCount: 0, gapPeriodsJson: null, createdAt: now,
      lines: [
        { id: randomUUID(), preInvoiceId: id, concept: 'Término de energía P1', period: 1,
          quantity: kwh, unit: 'kWh', unitPrice: energyTerm / kwh, amount: energyTerm, sortOrder: 1 },
      ],
    };
  };
  const preInvoices: Row[] = [
    buildPreInvoice('supply-30td', 'T_3_0TD', 2, 16800, 82000), // mar
    buildPreInvoice('supply-30td', 'T_3_0TD', 3, 17850, 84200), // abr
    buildPreInvoice('supply-30td', 'T_3_0TD', 4, 17200, 83100), // may
    buildPreInvoice('supply-20td', 'T_2_0TD', 2, 940, 3980), // mar
    buildPreInvoice('supply-20td', 'T_2_0TD', 3, 980, 4120), // abr
    buildPreInvoice('supply-20td', 'T_2_0TD', 4, 910, 3870), // may
  ];

  // M02 — una optimización recomendada para supply-30td (ahorro anual potencial en el panel).
  const powerOptimizations: Row[] = [
    {
      id: randomUUID(), supplyId: 'supply-30td', tariff: 'T_3_0TD',
      analysisFrom: new Date('2025-06-01T00:00:00.000Z'), analysisTo: new Date('2026-06-01T00:00:00.000Z'),
      granularity: 'hourly', upliftFactor: 1.05, sampleCount: 8760,
      fixedSaving: 2600, excessSaving: 600, annualSaving: 3200,
      recommendChange: true, changeAllowed: true, changeBlockedUntil: null,
      periods: [], createdAt: now,
    },
  ];

  // M03 — alertas abiertas sembradas (severidades distintas) + config por suministro.
  const alerts: Row[] = [
    {
      id: randomUUID(), supplyId: 'supply-30td', type: 'LIMIT', severity: 'CRITICAL', status: 'NEW',
      period: 3, windowStart: new Date('2026-05-20T18:00:00.000Z'), windowEnd: new Date('2026-05-20T19:00:00.000Z'),
      observedValue: 49.2, expectedValue: 47.5, deviation: 1.04,
      message: 'Potencia cercana al límite contratado en P3', detectedAt: new Date('2026-05-20T19:05:00.000Z'),
      acknowledgedBy: null, acknowledgedAt: null,
    },
    {
      id: randomUUID(), supplyId: 'supply-30td', type: 'ZSCORE', severity: 'WARNING', status: 'NEW',
      period: 2, windowStart: new Date('2026-05-18T03:00:00.000Z'), windowEnd: new Date('2026-05-18T04:00:00.000Z'),
      observedValue: 38.1, expectedValue: 12.4, deviation: 3.2,
      message: 'Consumo atípico en franja nocturna', detectedAt: new Date('2026-05-18T04:10:00.000Z'),
      acknowledgedBy: null, acknowledgedAt: null,
    },
    {
      id: randomUUID(), supplyId: 'supply-20td', type: 'ESTIMATED', severity: 'INFO', status: 'NEW',
      period: 0, windowStart: new Date('2026-05-15T00:00:00.000Z'), windowEnd: new Date('2026-05-16T00:00:00.000Z'),
      observedValue: 0, expectedValue: null, deviation: null,
      message: 'Lectura estimada (hueco DATADIS)', detectedAt: new Date('2026-05-16T06:00:00.000Z'),
      acknowledgedBy: null, acknowledgedAt: null,
    },
  ];
  const defaultWindows = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '06:00' }];
  const alertConfigs: Row[] = ['supply-20td', 'supply-30td'].map(supplyId => ({
    id: randomUUID(), supplyId, enabled: true, sensitivity: 'EQUILIBRADO',
    enabledTypes: 'ZSCORE,PHANTOM,LIMIT,ESTIMATED', limitThresholdPct: 0.95, phantomThresholdKwh: 1,
    inactivityWindows: defaultWindows, createdAt: now, updatedAt: now,
  }));

  // M04 — KPI: un fichero de producción sembrado para supply-30td (3 días, 2 turnos/día) con el
  // turno de mañana del día 06 a baja producción → su día sale como outlier en granularidad DAY.
  const kpiUploadId = 'upload-demo-30td';
  const shiftRow = (day: string, shift: string, startH: number, endH: number, units: number): Row => ({
    id: randomUUID(),
    uploadId: kpiUploadId,
    startTs: new Date(`2026-05-${day}T${String(startH).padStart(2, '0')}:00:00.000Z`),
    endTs: new Date(`2026-05-${day}T${String(endH).padStart(2, '0')}:00:00.000Z`),
    units,
    shift,
    line: null,
    batch: null,
  });
  const productionRows: Row[] = [
    shiftRow('04', 'M', 6, 14, 2000), shiftRow('04', 'T', 14, 22, 1800),
    shiftRow('05', 'M', 6, 14, 2000), shiftRow('05', 'T', 14, 22, 1800),
    shiftRow('06', 'M', 6, 14, 800), shiftRow('06', 'T', 14, 22, 1800), // día 06 atípico (baja producción)
  ];
  const productionUploads: Row[] = [
    {
      id: kpiUploadId, supplyId: 'supply-30td', fileName: 'produccion-demo.csv', format: 'CSV',
      rowCount: productionRows.length, rangeStart: new Date('2026-05-04T06:00:00.000Z'),
      rangeEnd: new Date('2026-05-06T22:00:00.000Z'), uploadedAt: now, uploadedBy: null,
    },
  ];
  const kpiReports: Row[] = [];
  const kpiReportLines: Row[] = [];

  // M05 — huella de carbono: un informe sembrado para supply-30td (3 meses) con el factor propio
  // por debajo de la media nacional (deltaPct negativo: "consume más limpio que la media").
  const carbonReportId = 'carbon-demo-30td';
  const carbonLine = (monthKey: string, kwh: number, factorAvg: number): Row => ({
    id: randomUUID(),
    reportId: carbonReportId,
    monthKey,
    monthStart: new Date(`${monthKey}-01T00:00:00.000Z`),
    kwh,
    co2Kg: (kwh * factorAvg) / 1000,
    factorAvg,
    hasGaps: false,
  });
  const carbonReportLines: Row[] = [
    carbonLine('2026-03', 42000, 235),
    carbonLine('2026-04', 39500, 228),
    carbonLine('2026-05', 41000, 240),
  ];
  const carbonTotalKwh = (carbonReportLines as { kwh: number }[]).reduce((a, l) => a + l.kwh, 0);
  const carbonTotalCo2 = (carbonReportLines as { co2Kg: number }[]).reduce((a, l) => a + l.co2Kg, 0);
  const carbonReports: Row[] = [
    {
      id: carbonReportId, supplyId: 'supply-30td',
      rangeStart: new Date('2026-03-01T00:00:00.000Z'), rangeEnd: new Date('2026-06-01T00:00:00.000Z'),
      totalKwh: carbonTotalKwh, totalCo2Kg: carbonTotalCo2,
      ownFactorGPerKwh: (carbonTotalCo2 * 1000) / carbonTotalKwh, nationalAvgFactor: 285,
      deltaPct: ((carbonTotalCo2 * 1000) / carbonTotalKwh - 285) / 285,
      hasGaps: false, computedAt: now,
    },
  ];

  // M06 — autoconsumo solar: una simulación sembrada para supply-30td (12 meses, ratios y payback
  // realistas) para que /solar muestre datos al entrar sin simular.
  const solarMonths = [0.55, 0.65, 0.85, 1.1, 1.3, 1.45, 1.45, 1.35, 1.1, 0.85, 0.65, 0.5];
  const solarFactorSum = solarMonths.reduce((a, b) => a + b, 0);
  const solarKwp = 40;
  const solarAnnualProd = solarKwp * 1500 * (1 - 0.14); // ~51600 kWh
  const solarMonthlyJson = solarMonths.map((f, i) => {
    const prod = (solarAnnualProd * f) / solarFactorSum;
    const self = prod * 0.55; // ~55 % autoconsumo
    return {
      key: `2025-${String(i + 1).padStart(2, '0')}`,
      monthStart: new Date(Date.UTC(2025, i, 1)).toISOString(),
      productionKwh: prod,
      selfConsumptionKwh: self,
      surplusKwh: prod - self,
    };
  });
  const solarSelf = solarMonthlyJson.reduce((a, m) => a + m.selfConsumptionKwh, 0);
  const solarSurplus = solarMonthlyJson.reduce((a, m) => a + m.surplusKwh, 0);
  const solarSaving = solarSelf * 0.16 + solarSurplus * 0.06; // coste evitado + excedentes
  const solarSimulations: Row[] = [
    {
      id: 'solar-demo-30td', supplyId: 'supply-30td',
      lat: 41.65, lon: -0.88, kwp: solarKwp, lossPct: 14, tilt: 35, azimuth: 0, costPerKwp: 1000,
      rangeStart: new Date('2025-01-01T00:00:00.000Z'), rangeEnd: new Date('2026-01-01T00:00:00.000Z'),
      annualProductionKwh: solarAnnualProd, monthlyProductionJson: JSON.stringify(solarMonthlyJson),
      annualSelfConsumptionKwh: solarSelf, annualSurplusKwh: solarSurplus,
      selfConsumptionRatio: solarSelf / solarAnnualProd, coverageRatio: 0.32,
      annualSavingEur: solarSaving, paybackYears: (solarKwp * 1000) / solarSaving, computedAt: now,
    },
  ];

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

    client: {
      findUnique: async ({ where }: { where: Row }) => findUniqueBy(clients, where),
      findMany: async ({ where = {} }: { where?: Row } = {}) =>
        clients.filter(c => Object.keys(where).every(k => where[k] === undefined || c[k] === where[k])),
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

    powerOptimization: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = powerOptimizations.find(o => o.id === where.id) ?? null;
        else if (where.supplyId_analysisFrom_analysisTo) {
          const k = where.supplyId_analysisFrom_analysisTo as Row;
          row = powerOptimizations.find(o =>
            o.supplyId === k.supplyId &&
            (o.analysisFrom as Date).getTime() === (k.analysisFrom as Date).getTime() &&
            (o.analysisTo as Date).getTime() === (k.analysisTo as Date).getTime(),
          ) ?? null;
        }
        return row ? withOptIncludes(row, include, supplies) : null;
      },
      findMany: async ({ where, orderBy, take, skip }: { where: Row; include?: Row; orderBy?: Row; take?: number; skip?: number }) => {
        let list = powerOptimizations.filter(o => o.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).analysisTo === 'desc') {
          list = [...list].sort((a, b) => (b.analysisTo as Date).getTime() - (a.analysisTo as Date).getTime());
        }
        if (skip) list = list.slice(skip);
        if (take !== undefined) list = list.slice(0, take);
        return list.map(o => ({ ...o, periods: o.periods }));
      },
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        const periods = extractPeriods(data);
        const row: Row = { id: randomUUID(), createdAt: new Date(), ...stripPeriods(data), periods };
        powerOptimizations.push(row);
        return withOptIncludes(row, include, supplies);
      },
      update: async ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
        const row = powerOptimizations.find(o => o.id === where.id);
        if (!row) throw new Error('powerOptimization no encontrada');
        const periods = data.periods ? extractPeriods(data) : (row.periods as Row[]);
        Object.assign(row, stripPeriods(data), { periods });
        return withOptIncludes(row, include, supplies);
      },
      delete: async ({ where }: { where: Row }) => {
        const i = powerOptimizations.findIndex(o => o.id === where.id);
        if (i >= 0) powerOptimizations.splice(i, 1);
        return {};
      },
    },

    powerOptimizationPeriod: {
      deleteMany: async ({ where }: { where: Row }) => {
        const o = powerOptimizations.find(p => p.id === where.optimizationId);
        if (o) o.periods = [];
        return { count: 0 };
      },
    },

    alertConfig: {
      findUnique: async ({ where }: { where: Row }) => {
        if (where.id) return alertConfigs.find(c => c.id === where.id) ?? null;
        return alertConfigs.find(c => c.supplyId === where.supplyId) ?? null;
      },
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        alertConfigs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = where.id
          ? alertConfigs.find(c => c.id === where.id)
          : alertConfigs.find(c => c.supplyId === where.supplyId);
        if (!row) throw new Error('alertConfig no encontrada');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },

    alert: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = alerts.find(a => a.id === where.id) ?? null;
        else if (where.supplyId_type_windowStart_period) {
          const k = where.supplyId_type_windowStart_period as Row;
          row = alerts.find(a =>
            a.supplyId === k.supplyId &&
            a.type === k.type &&
            (a.windowStart as Date).getTime() === (k.windowStart as Date).getTime() &&
            a.period === k.period,
          ) ?? null;
        }
        return row ? withAlertIncludes(row, include, supplies) : null;
      },
      findMany: async ({ where, orderBy, take, skip }: { where: Row; orderBy?: Row; take?: number; skip?: number }) => {
        let list = alerts.filter(a =>
          a.supplyId === where.supplyId &&
          (where.status === undefined || a.status === where.status) &&
          (where.type === undefined || a.type === where.type),
        );
        if (orderBy && (orderBy as Row).windowStart === 'desc') {
          list = [...list].sort((a, b) => (b.windowStart as Date).getTime() - (a.windowStart as Date).getTime());
        }
        if (skip) list = list.slice(skip);
        if (take !== undefined) list = list.slice(0, take);
        return list;
      },
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          id: randomUUID(), status: 'NEW', detectedAt: new Date(),
          acknowledgedBy: null, acknowledgedAt: null, expectedValue: null, deviation: null, ...data,
        };
        alerts.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = alerts.find(a => a.id === where.id);
        if (!row) throw new Error('alert no encontrada');
        Object.assign(row, data);
        return row;
      },
    },

    productionUpload: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const row = where.id ? productionUploads.find(u => u.id === where.id) ?? null : null;
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.rows) out.rows = productionRows.filter(r => r.uploadId === row.id);
        if (include?.supply) out.supply = supplies.find(s => s.id === row.supplyId) ?? null;
        return out;
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        let list = productionUploads.filter(u => u.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).uploadedAt === 'desc') {
          list = [...list].sort((a, b) => (b.uploadedAt as Date).getTime() - (a.uploadedAt as Date).getTime());
        }
        return list;
      },
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        const rowsSpec = (data.rows as { create?: Row[] } | undefined)?.create ?? [];
        const { rows, ...rest } = data;
        void rows;
        const id = randomUUID();
        const row: Row = { id, uploadedAt: new Date(), uploadedBy: null, ...rest };
        productionUploads.push(row);
        const created = rowsSpec.map(r => ({ id: randomUUID(), uploadId: id, ...r }));
        productionRows.push(...created);
        const out: Row = { ...row };
        if (include?.rows) out.rows = created;
        return out;
      },
    },

    kpiReport: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = kpiReports.find(r => r.id === where.id) ?? null;
        else if (where.uploadId_granularity) {
          const k = where.uploadId_granularity as Row;
          row = kpiReports.find(r => r.uploadId === k.uploadId && r.granularity === k.granularity) ?? null;
        }
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.lines) out.lines = kpiReportLines.filter(l => l.reportId === row!.id);
        if (include?.supply) out.supply = supplies.find(s => s.id === row!.supplyId) ?? null;
        return out;
      },
      findMany: async ({ where, orderBy, include }: { where: Row; orderBy?: Row; include?: Row }) => {
        let list = kpiReports.filter(r => r.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).computedAt === 'desc') {
          list = [...list].sort((a, b) => (b.computedAt as Date).getTime() - (a.computedAt as Date).getTime());
        }
        return list.map(r => (include?.lines ? { ...r, lines: kpiReportLines.filter(l => l.reportId === r.id) } : r));
      },
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        const linesSpec = (data.lines as { create?: Row[] } | undefined)?.create ?? [];
        const { lines, ...rest } = data;
        void lines;
        const id = randomUUID();
        const row: Row = { id, computedAt: new Date(), outlierPct: 0.2, hasGaps: false, ...rest };
        kpiReports.push(row);
        const created = linesSpec.map(l => ({ id: randomUUID(), reportId: id, ...l }));
        kpiReportLines.push(...created);
        const out: Row = { ...row };
        if (include?.lines) out.lines = created;
        return out;
      },
      update: async ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
        const row = kpiReports.find(r => r.id === where.id);
        if (!row) throw new Error('kpiReport no encontrada');
        const linesSpec = (data.lines as { create?: Row[] } | undefined)?.create;
        const { lines, ...rest } = data;
        void lines;
        Object.assign(row, rest);
        if (linesSpec) {
          const created = linesSpec.map(l => ({ id: randomUUID(), reportId: row.id, ...l }));
          kpiReportLines.push(...created);
        }
        const out: Row = { ...row };
        if (include?.lines) out.lines = kpiReportLines.filter(l => l.reportId === row.id);
        return out;
      },
    },

    kpiReportLine: {
      deleteMany: async ({ where }: { where: Row }) => {
        for (let i = kpiReportLines.length - 1; i >= 0; i--) {
          if (kpiReportLines[i].reportId === where.reportId) kpiReportLines.splice(i, 1);
        }
        return { count: 0 };
      },
    },

    carbonReport: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = carbonReports.find(r => r.id === where.id) ?? null;
        else if (where.supplyId_rangeStart_rangeEnd) {
          const k = where.supplyId_rangeStart_rangeEnd as Row;
          row = carbonReports.find(r =>
            r.supplyId === k.supplyId &&
            (r.rangeStart as Date).getTime() === (k.rangeStart as Date).getTime() &&
            (r.rangeEnd as Date).getTime() === (k.rangeEnd as Date).getTime(),
          ) ?? null;
        }
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.lines) out.lines = carbonReportLines.filter(l => l.reportId === row!.id);
        if (include?.supply) out.supply = supplies.find(s => s.id === row!.supplyId) ?? null;
        return out;
      },
      findMany: async ({ where, orderBy, include }: { where: Row; orderBy?: Row; include?: Row }) => {
        let list = carbonReports.filter(r => r.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).computedAt === 'desc') {
          list = [...list].sort((a, b) => (b.computedAt as Date).getTime() - (a.computedAt as Date).getTime());
        }
        return list.map(r => (include?.lines ? { ...r, lines: carbonReportLines.filter(l => l.reportId === r.id) } : r));
      },
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        const linesSpec = (data.lines as { create?: Row[] } | undefined)?.create ?? [];
        const { lines, ...rest } = data;
        void lines;
        const id = randomUUID();
        const row: Row = { id, computedAt: new Date(), hasGaps: false, ...rest };
        carbonReports.push(row);
        const created = linesSpec.map(l => ({ id: randomUUID(), reportId: id, ...l }));
        carbonReportLines.push(...created);
        const out: Row = { ...row };
        if (include?.lines) out.lines = created;
        return out;
      },
      update: async ({ where, data, include }: { where: Row; data: Row; include?: Row }) => {
        const row = carbonReports.find(r => r.id === where.id);
        if (!row) throw new Error('carbonReport no encontrada');
        const linesSpec = (data.lines as { create?: Row[] } | undefined)?.create;
        const { lines, ...rest } = data;
        void lines;
        Object.assign(row, rest);
        if (linesSpec) {
          const created = linesSpec.map(l => ({ id: randomUUID(), reportId: row.id, ...l }));
          carbonReportLines.push(...created);
        }
        const out: Row = { ...row };
        if (include?.lines) out.lines = carbonReportLines.filter(l => l.reportId === row.id);
        return out;
      },
    },

    carbonReportLine: {
      deleteMany: async ({ where }: { where: Row }) => {
        for (let i = carbonReportLines.length - 1; i >= 0; i--) {
          if (carbonReportLines[i].reportId === where.reportId) carbonReportLines.splice(i, 1);
        }
        return { count: 0 };
      },
    },

    solarSimulation: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let row: Row | null = null;
        if (where.id) row = solarSimulations.find(s => s.id === where.id) ?? null;
        else if (where.supplyId_lat_lon_kwp_lossPct_tilt_azimuth) {
          const k = where.supplyId_lat_lon_kwp_lossPct_tilt_azimuth as Row;
          row = solarSimulations.find(s =>
            s.supplyId === k.supplyId && s.lat === k.lat && s.lon === k.lon && s.kwp === k.kwp &&
            s.lossPct === k.lossPct && s.tilt === k.tilt && s.azimuth === k.azimuth,
          ) ?? null;
        }
        if (!row) return null;
        const out: Row = { ...row };
        if (include?.supply) out.supply = supplies.find(s => s.id === row!.supplyId) ?? null;
        return out;
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        let list = solarSimulations.filter(s => s.supplyId === where.supplyId);
        if (orderBy && (orderBy as Row).computedAt === 'desc') {
          list = [...list].sort((a, b) => (b.computedAt as Date).getTime() - (a.computedAt as Date).getTime());
        }
        return list;
      },
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: randomUUID(), computedAt: new Date(), ...data };
        solarSimulations.push(row);
        return row;
      },
    },

    tollRate: { findMany: async ({ where }: { where: Row }) => tollRates.filter(r => r.tariff === where.tariff) },
    chargeRate: { findMany: async ({ where }: { where: Row }) => chargeRates.filter(r => r.tariff === where.tariff) },
    iEERate: { findFirst: async () => ieeRates[0] ?? null },
    vATRate: { findFirst: async () => vatRates[0] ?? null },
    meterRentalRate: { findFirst: async ({ where }: { where: Row }) => meterRentalRates.find(r => r.tariff === where.tariff) ?? null },
    reactiveEnergyRate: { findMany: async () => reactiveEnergyRates },
    excessPowerRate: { findMany: async ({ where }: { where: Row }) => excessPowerRates.filter(r => r.tariff === where.tariff) },
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

// ─── utilidades de períodos anidados (data.periods.create) — M02 ───────────────
function extractPeriods(data: Row): Row[] {
  const spec = data.periods as { create?: Row[] } | undefined;
  const created = spec?.create ?? [];
  return created.map(p => ({ id: randomUUID(), ...p }));
}
function stripPeriods(data: Row): Row {
  const { periods, ...rest } = data;
  void periods;
  return rest;
}
function withOptIncludes(row: Row, include: Row | undefined, supplies: Row[]): Row {
  const out: Row = { ...row };
  if (include?.supply) out.supply = supplies.find(s => s.id === row.supplyId) ?? null;
  if (include?.periods) out.periods = (row.periods as Row[]) ?? [];
  return out;
}

// ─── includes de alertas (M03) ────────────────────────────────────────────────
function withAlertIncludes(row: Row, include: Row | undefined, supplies: Row[]): Row {
  const out: Row = { ...row };
  if (include?.supply) out.supply = supplies.find(s => s.id === row.supplyId) ?? null;
  return out;
}
