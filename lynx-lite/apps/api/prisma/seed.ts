import { PrismaClient, Tariff, RateType, PowerControl, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Fecha de vigencia abierta: cubre cualquier período de test.
const VALID_FROM = new Date('2020-01-01T00:00:00.000Z');

// Valores alineados con los casos de test del SPECS §3.6.
const TOLL_POWER = {
  T_2_0TD: { 1: 0.115327, 2: 0.002572 },
  T_3_0TD: { 1: 0.115327, 2: 0.082748, 3: 0.024894, 4: 0.024894, 5: 0.003695, 6: 0.002572 },
};
const TOLL_ENERGY = {
  T_2_0TD: { 1: 0.007215, 2: 0.004860, 3: 0.000841 },
  T_3_0TD: { 1: 0.009518, 2: 0.006872, 3: 0.003558, 4: 0.003558, 5: 0.002122, 6: 0.000841 },
};
const CHARGE_POWER = {
  T_2_0TD: { 1: 0.011000, 2: 0.001000 },
  T_3_0TD: { 1: 0.015000, 2: 0.010000, 3: 0.006000, 4: 0.006000, 5: 0.002000, 6: 0.001000 },
};
const CHARGE_ENERGY = {
  T_2_0TD: { 1: 0.003000, 2: 0.002000, 3: 0.001000 },
  T_3_0TD: { 1: 0.005000, 2: 0.004000, 3: 0.003000, 4: 0.003000, 5: 0.002000, 6: 0.001000 },
};
// Término de exceso de potencia tepp4-5 (€/kW·día), tipos 4 y 5 (art. 9.4.b.1).
// Valores OFICIALES del Anexo II de la Resolución de peajes vigente desde 1-ene-2026
// (BOE-A-2025-26348). 2.0TD solo tiene 2 períodos de potencia.
// Histórico: desde 1-abr-2025 (BOE-A-2025-5341) eran 2.0TD P1 0,275041 P2 0,005297;
// 3.0TD P1 0,168944 P2 0,089294 P3 0,028322 P4 0,021656 P5/P6 0,006126.
// Nota: se siembran con validFrom 2020-01-01 (como el resto del seed) para cubrir los
// períodos de los TC; en producción deben versionarse por su validFrom real (2025-04-01 / 2026-01-01).
const EXCESS_POWER = {
  T_2_0TD: { 1: 0.279426, 2: 0.005316 },
  T_3_0TD: { 1: 0.171373, 2: 0.090584, 3: 0.028721, 4: 0.021891, 5: 0.006142, 6: 0.006142 },
};

async function seedRates() {
  await prisma.iEERate.create({ data: { rate: 0.0511269632, validFrom: VALID_FROM } });
  await prisma.vATRate.create({ data: { rate: 0.21, validFrom: VALID_FROM } });

  await prisma.meterRentalRate.createMany({
    data: [
      { tariff: Tariff.T_2_0TD, eurPerDay: 0.026114, validFrom: VALID_FROM },
      { tariff: Tariff.T_3_0TD, eurPerDay: 0.039660, validFrom: VALID_FROM },
    ],
  });

  await prisma.reactiveEnergyRate.createMany({
    data: [
      { tier: 1, eur: 0.041554, validFrom: VALID_FROM },
      { tier: 2, eur: 0.062332, validFrom: VALID_FROM },
    ],
  });

  for (const tariff of [Tariff.T_2_0TD, Tariff.T_3_0TD] as const) {
    for (const [period, eur] of Object.entries(TOLL_POWER[tariff])) {
      await prisma.tollRate.create({
        data: { tariff, period: Number(period), rateType: RateType.POWER, eur, validFrom: VALID_FROM },
      });
    }
    for (const [period, eur] of Object.entries(TOLL_ENERGY[tariff])) {
      await prisma.tollRate.create({
        data: { tariff, period: Number(period), rateType: RateType.ENERGY, eur, validFrom: VALID_FROM },
      });
    }
    for (const [period, eur] of Object.entries(CHARGE_POWER[tariff])) {
      await prisma.chargeRate.create({
        data: { tariff, period: Number(period), rateType: RateType.POWER, eur, validFrom: VALID_FROM },
      });
    }
    for (const [period, eur] of Object.entries(CHARGE_ENERGY[tariff])) {
      await prisma.chargeRate.create({
        data: { tariff, period: Number(period), rateType: RateType.ENERGY, eur, validFrom: VALID_FROM },
      });
    }
    for (const [period, eurPerDay] of Object.entries(EXCESS_POWER[tariff])) {
      await prisma.excessPowerRate.create({
        data: { tariff, period: Number(period), eurPerDay, validFrom: VALID_FROM },
      });
    }
  }
}

async function seedUsersAndSupplies() {
  // Superadmin de plataforma (rol DOMINION, único).
  await prisma.user.create({
    data: {
      email: 'dominion@lynx.local',
      passwordHash: await bcrypt.hash('dominion', 10),
      name: 'Dominion Admin',
      role: UserRole.DOMINION,
    },
  });

  // Cliente de prueba + suministro 2.0TD con contrato vigente y backfill completo.
  const client = await prisma.client.create({
    data: { name: 'Pyme Demo S.L.', vatNumber: 'B12345678', email: 'demo@pyme.local' },
  });

  const supply = await prisma.supply.create({
    data: {
      cups: 'ES0031000000000001JN',
      clientId: client.id,
      address: 'Calle Demo 1, Madrid',
      tariff: Tariff.T_2_0TD,
      backfillStatus: 'DONE',
    },
  });

  await prisma.contract.create({
    data: {
      supplyId: supply.id,
      validFrom: VALID_FROM,
      contractedPowerP1: 10.0,
      contractedPowerP2: 10.0,
      modePowerControl: PowerControl.ICP,
      hasSurplus: false,
    },
  });

  // ADMIN del cliente demo.
  await prisma.user.create({
    data: {
      email: 'admin@pyme.local',
      passwordHash: await bcrypt.hash('admin', 10),
      name: 'Admin Pyme',
      role: UserRole.ADMIN,
      clientId: client.id,
    },
  });
}

async function main() {
  await seedRates();
  await seedUsersAndSupplies();
  console.log('Seed completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
