import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock del singleton de Prisma. vi.hoisted construye el mock antes que vi.mock,
// que está hoisted por encima de cualquier const normal.
const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
    user: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    client: d('create', 'findUnique'),
    supply: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    contract: d('findFirst'),
    preInvoice: d('findUnique', 'findMany', 'create', 'update', 'delete'),
    preInvoiceLine: d('deleteMany'),
    tollRate: d('findMany'),
    chargeRate: d('findMany'),
    iEERate: d('findFirst'),
    vATRate: d('findFirst'),
    meterRentalRate: d('findFirst'),
    reactiveEnergyRate: d('findMany'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { hashPassword } from '../../src/services/auth.js';
import { buildContext } from '../../src/context.js';
import { setDataSource } from '../../src/services/runtime.js';
import type { PreInvoiceDataSource } from '../../src/services/preInvoiceData.js';

const server = buildServer();

// DataSource mock para los casos que llegan al calculo (TC-AUTH-007).
const dataSourceMock: PreInvoiceDataSource = {
  load: vi.fn().mockResolvedValue({
    consumptionByPeriod: { P1: 100, P2: 100, P3: 100 },
    maxPowerByPeriod: {},
    pvpcByPeriod: { P1: 0.1, P2: 0.1, P3: 0.1 },
    gapHoursByPeriod: {},
    totalGapHours: 0,
    hasBillableData: true,
  }),
  loadReactiveByPeriod: vi.fn().mockResolvedValue(null),
};
setDataSource(dataSourceMock);

// Limpia los registros de llamada de Prisma entre tests (mantiene implementaciones).
beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
});

// TC-AUTH-001 - Login correcto
describe('TC-AUTH-001 - login correcto', () => {
  it('devuelve token JWT con payload valido y exp-iat = 8h', async () => {
    const passwordHash = await hashPassword('correct');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1', email: 'admin@client.com', passwordHash, name: 'Admin',
      role: 'ADMIN', clientId: 'client-A', supplyId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await runOp(
      server,
      `mutation { login(input: { email: "admin@client.com", password: "correct" }) { token user { role } } }`,
    );

    expect(res.errors).toBeUndefined();
    const token = (res.data as { login: { token: string } }).login.token;
    const decoded = jwt.verify(token, 'test-secret') as { sub: string; role: string; clientId: string; iat: number; exp: number };
    expect(decoded.sub).toBe('u1');
    expect(decoded.role).toBe('ADMIN');
    expect(decoded.clientId).toBe('client-A');
    expect(decoded.exp - decoded.iat).toBe(8 * 3600);
  });
});

// TC-AUTH-002 - Contrasena incorrecta
describe('TC-AUTH-002 - contrasena incorrecta', () => {
  it('eleva UNAUTHENTICATED', async () => {
    const passwordHash = await hashPassword('correct');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1', email: 'admin@client.com', passwordHash, name: 'Admin',
      role: 'ADMIN', clientId: 'client-A', supplyId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await runOp(
      server,
      `mutation { login(input: { email: "admin@client.com", password: "WRONG" }) { token } }`,
    );
    expect(errorCode(res)).toBe('UNAUTHENTICATED');
  });
});

// TC-AUTH-003 - Request sin token
describe('TC-AUTH-003 - request sin token', () => {
  it('buildContext devuelve user null y me eleva UNAUTHENTICATED', async () => {
    const ctx = await buildContext({ req: { headers: {} } as never });
    expect(ctx.user).toBeNull();

    const res = await runOp(server, `query { me { id } }`, { user: null });
    expect(errorCode(res)).toBe('UNAUTHENTICATED');
  });
});

// TC-AUTH-004 - Token expirado
describe('TC-AUTH-004 - token expirado', () => {
  it('buildContext con token expirado devuelve user null', async () => {
    const expired = jwt.sign({ sub: 'u1', role: 'ADMIN' }, 'test-secret', { expiresIn: '-1h' });
    const ctx = await buildContext({ req: { headers: { authorization: `Bearer ${expired}` } } as never });
    expect(ctx.user).toBeNull();
  });
});

// TC-AUTH-005 - USUARIO intenta savePreInvoice -> FORBIDDEN
describe('TC-AUTH-005 - USUARIO no puede savePreInvoice', () => {
  it('eleva FORBIDDEN', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', backfillStatus: 'DONE',
    });

    const res = await runOp(
      server,
      `mutation { savePreInvoice(input: { cups: "ES_CUPS", periodFrom: "2025-01-01", periodTo: "2025-01-31" }) { id } }`,
      { user: { id: 'u1', role: 'USUARIO', clientId: 'client-A', supplyId: 's1' } },
    );
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

// TC-AUTH-006 - ADMIN accede a supply de otro cliente -> FORBIDDEN
describe('TC-AUTH-006 - ADMIN cross-client', () => {
  it('eleva FORBIDDEN al calcular pre-factura de otro cliente', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's-b', cups: 'ES_CUPS_B', clientId: 'client-B', backfillStatus: 'DONE',
    });

    const res = await runOp(
      server,
      `query { calculatePreInvoice(input: { cups: "ES_CUPS_B", periodFrom: "2025-01-01", periodTo: "2025-01-31" }) { total } }`,
      { user: { id: 'admin-a', role: 'ADMIN', clientId: 'client-A' } },
    );
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

// TC-AUTH-007 - GESTOR calcula pre-factura de su propio supply -> OK
describe('TC-AUTH-007 - GESTOR de su supply', () => {
  it('no eleva error de autorizacion', async () => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: 'DONE',
    });
    mockPrisma.contract.findFirst.mockResolvedValue({
      id: 'c1', supplyId: 's1', validFrom: new Date('2020-01-01'), validTo: null,
      contractedPowerP1: 10, contractedPowerP2: 10, contractedPowerP3: null,
      contractedPowerP4: null, contractedPowerP5: null, contractedPowerP6: null,
      modePowerControl: 'ICP', hasSurplus: false, createdAt: new Date(),
    });
    mockPrisma.tollRate.findMany.mockResolvedValue([
      { period: 1, rateType: 'POWER', eur: 0.1 }, { period: 2, rateType: 'POWER', eur: 0.01 },
      { period: 1, rateType: 'ENERGY', eur: 0.01 }, { period: 2, rateType: 'ENERGY', eur: 0.01 }, { period: 3, rateType: 'ENERGY', eur: 0.01 },
    ]);
    mockPrisma.chargeRate.findMany.mockResolvedValue([
      { period: 1, rateType: 'POWER', eur: 0.01 }, { period: 2, rateType: 'POWER', eur: 0.01 },
      { period: 1, rateType: 'ENERGY', eur: 0.01 }, { period: 2, rateType: 'ENERGY', eur: 0.01 }, { period: 3, rateType: 'ENERGY', eur: 0.01 },
    ]);
    mockPrisma.iEERate.findFirst.mockResolvedValue({ rate: 0.0511269632 });
    mockPrisma.vATRate.findFirst.mockResolvedValue({ rate: 0.21 });
    mockPrisma.meterRentalRate.findFirst.mockResolvedValue({ eurPerDay: 0.026 });
    mockPrisma.reactiveEnergyRate.findMany.mockResolvedValue([]);

    const res = await runOp(
      server,
      `query { calculatePreInvoice(input: { cups: "ES_CUPS", periodFrom: "2025-01-01", periodTo: "2025-01-31" }) { total } }`,
      { user: { id: 'gestor1', role: 'GESTOR', clientId: 'client-A', supplyId: 's1' } },
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as { calculatePreInvoice: { total: number } }).calculatePreInvoice.total).toBeGreaterThan(0);
  });
});
