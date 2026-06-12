import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => {
  const d = (...m: string[]) => Object.fromEntries(m.map(k => [k, vi.fn()]));
  return {
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

// Spy sobre el disparador de backfill (TC-PRE-011).
const enqueueSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/backfillTrigger.js', () => ({ enqueueBackfill: enqueueSpy }));

import { buildServer, runOp, errorCode } from '../harness.js';
import { setDataSource } from '../../src/services/runtime.js';
import type { PreInvoiceDataSource } from '../../src/services/preInvoiceData.js';

const server = buildServer();
const DOMINION = { id: 'dom', role: 'DOMINION' as const };

setDataSource({
  load: vi.fn(),
  loadReactiveByPeriod: vi.fn(),
} as unknown as PreInvoiceDataSource);

beforeEach(() => {
  for (const delegate of Object.values(mockPrisma)) {
    for (const fn of Object.values(delegate as Record<string, ReturnType<typeof vi.fn>>)) fn.mockReset();
  }
  enqueueSpy.mockReset();
});

const CREATE = `mutation($i: CreateSupplyInput!) { createSupply(input: $i) { id backfillStatus } }`;
const CALC = `query($i: PreInvoiceInput!) { calculatePreInvoice(input: $i) { total } }`;
const period = { cups: 'ES_CUPS', periodFrom: '2025-01-01', periodTo: '2025-01-31' };

// TC-PRE-011 - createSupply lanza backfill en background
describe('TC-PRE-011 - createSupply lanza backfill', () => {
  it('crea con backfillStatus PENDING y registra el backfill', async () => {
    mockPrisma.supply.create.mockResolvedValue({
      id: 's-new', cups: 'ES_NEW', clientId: 'client-A', address: null,
      tariff: 'T_2_0TD', backfillStatus: 'PENDING', createdAt: new Date(),
    });

    const res = await runOp(server, CREATE, {
      variables: { i: { cups: 'ES_NEW', clientId: 'client-A', tariff: 'T_2_0TD' } },
      user: DOMINION,
    });

    expect(res.errors).toBeUndefined();
    const supply = (res.data as { createSupply: { backfillStatus: string } }).createSupply;
    expect(supply.backfillStatus).toBe('PENDING');
    // Se registró el backfill para el supply creado.
    expect(enqueueSpy).toHaveBeenCalledWith('s-new');
    // create se llamó con backfillStatus PENDING.
    expect(mockPrisma.supply.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ backfillStatus: 'PENDING' }) }),
    );
  });
});

// TC-PRE-012/013/014 - calculatePreInvoice segun backfillStatus
describe('TC-PRE-012/013/014 - estados de backfill bloquean el cálculo', () => {
  it.each([
    ['PENDING', 'BACKFILL_PENDING'],
    ['RUNNING', 'BACKFILL_RUNNING'],
    ['FAILED', 'BACKFILL_FAILED'],
  ])('backfillStatus %s -> %s', async (status, code) => {
    mockPrisma.supply.findUnique.mockResolvedValue({
      id: 's1', cups: 'ES_CUPS', clientId: 'client-A', tariff: 'T_2_0TD', backfillStatus: status,
    });
    const res = await runOp(server, CALC, { variables: { i: period }, user: DOMINION });
    expect(errorCode(res)).toBe(code);
  });
});
