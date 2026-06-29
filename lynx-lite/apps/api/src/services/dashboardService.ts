import type { AuthUser } from '../context.js';
import { prisma as defaultPrisma } from '../lib/prisma.js';

// SPECS §11 — Dashboard de inicio (panel transversal).
// Vista derivada de SOLO datos persistidos: agrega lo que M01–M05 ya guardaron.
// No llama a DATADIS/ESIOS/REData ni recalcula nada (cero riesgo de 429, §3.1).
// El scope se deriva del rol del usuario (§2.2/§2.3), nunca de un argumento.

type PrismaLike = typeof defaultPrisma;

const OPEN_ALERT_STATUS = new Set(['NEW', 'ACKNOWLEDGED']);
const PER_SUPPLY_PREINVOICES = 24; // suficiente para coste último/anterior + serie de 6 meses
const RECENT_ALERTS_CAP = 8;
const MONTHLY_POINTS = 6;

interface SupplyRowDb {
  id: string;
  cups: string;
  clientId: string;
  tariff: string;
  status: string;
  backfillStatus: string;
}
interface PreInvoiceDb {
  total: number;
  periodFrom: Date;
  periodTo: Date;
  lines: { quantity: number; unit: string }[];
}
interface AlertDb {
  id: string;
  supplyId: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  detectedAt: Date;
}
interface OptimizationDb { annualSaving: number; recommendChange: boolean }
interface CarbonDb { deltaPct: number; totalKwh: number }

// Σ de las líneas de energía (unit = 'kWh') de una pre-factura (§11.0).
function kwhOf(pi: PreInvoiceDb | undefined): number | null {
  if (!pi) return null;
  return pi.lines.filter(l => l.unit === 'kWh').reduce((a, l) => a + l.quantity, 0);
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface ScopeResolution {
  scope: 'PLATFORM' | 'CLIENT' | 'SUPPLY';
  where: Record<string, unknown>;
}

function resolveScope(user: AuthUser): ScopeResolution {
  switch (user.role) {
    case 'DOMINION':
      return { scope: 'PLATFORM', where: {} };
    case 'ADMIN':
      return { scope: 'CLIENT', where: { clientId: user.clientId } };
    default: // GESTOR | USUARIO
      return { scope: 'SUPPLY', where: { id: user.supplyId } };
  }
}

export async function computeDashboard(user: AuthUser, prisma: PrismaLike = defaultPrisma) {
  const { scope, where } = resolveScope(user);

  const supplies = (await prisma.supply.findMany({ where })) as unknown as SupplyRowDb[];

  // Mapa clientId → nombre (cacheado; el demo y el real exponen client.findUnique).
  const clientNames = new Map<string, string | null>();
  for (const s of supplies) {
    if (clientNames.has(s.clientId)) continue;
    const c = (await prisma.client.findUnique({ where: { id: s.clientId } })) as { name?: string } | null;
    clientNames.set(s.clientId, c?.name ?? null);
  }

  const allPreInvoices: PreInvoiceDb[] = [];
  let lastCost = 0, prevCost = 0, lastKwh = 0;
  let anyLast = false, anyPrev = false;
  let openAlerts = 0, openAlertsHigh = 0;
  let savingSum = 0, anySaving = false;
  let co2Weighted = 0, co2Kwh = 0;
  const recent: (AlertDb & { cups: string })[] = [];

  const rows = await Promise.all(
    supplies.map(async (s) => {
      const preInvoices = (await prisma.preInvoice.findMany({
        where: { supplyId: s.id },
        orderBy: { periodFrom: 'desc' },
        take: PER_SUPPLY_PREINVOICES,
        include: { lines: true },
      })) as unknown as PreInvoiceDb[];

      const alerts = ((await prisma.alert.findMany({
        where: { supplyId: s.id },
      })) as unknown as AlertDb[]).filter(a => OPEN_ALERT_STATUS.has(a.status));

      const opt = ((await prisma.powerOptimization.findMany({
        where: { supplyId: s.id },
        orderBy: { analysisTo: 'desc' },
        take: 1,
      })) as unknown as OptimizationDb[])[0];

      const carbon = ((await prisma.carbonReport.findMany({
        where: { supplyId: s.id },
        orderBy: { computedAt: 'desc' },
        take: 1,
      })) as unknown as CarbonDb[])[0];

      return { s, preInvoices, alerts, opt, carbon };
    }),
  );

  const supplyRows = rows.map(({ s, preInvoices, alerts, opt, carbon }) => {
    allPreInvoices.push(...preInvoices);

    const last = preInvoices[0];
    const prev = preInvoices[1];
    const rowKwh = kwhOf(last);
    if (last) { lastCost += last.total; lastKwh += rowKwh ?? 0; anyLast = true; }
    if (prev) { prevCost += prev.total; anyPrev = true; }

    openAlerts += alerts.length;
    openAlertsHigh += alerts.filter(a => a.severity === 'CRITICAL').length;
    for (const a of alerts) recent.push({ ...a, cups: s.cups });

    const rowSaving = opt?.recommendChange ? opt.annualSaving : null;
    if (rowSaving != null) { savingSum += rowSaving; anySaving = true; }

    if (carbon) { co2Weighted += carbon.deltaPct * carbon.totalKwh; co2Kwh += carbon.totalKwh; }

    return {
      id: s.id,
      cups: s.cups,
      clientName: clientNames.get(s.clientId) ?? null,
      tariff: s.tariff,
      status: s.status,
      lastPeriod: last ? monthKey(last.periodFrom) : null,
      lastKwh: rowKwh,
      lastCostEur: last ? last.total : null,
      openAlerts: alerts.length,
      annualSavingEur: rowSaving,
      backfillStatus: s.backfillStatus,
    };
  });

  // Serie mensual: agrupa TODAS las pre-facturas por mes de periodFrom y se queda con los últimos 6.
  const byMonth = new Map<string, number>();
  for (const pi of allPreInvoices) {
    const k = monthKey(pi.periodFrom);
    byMonth.set(k, (byMonth.get(k) ?? 0) + pi.total);
  }
  const monthlyCost = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-MONTHLY_POINTS)
    .map(([month, eur]) => ({ month, eur }));

  const recentAlerts = recent
    .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
    .slice(0, RECENT_ALERTS_CAP)
    .map(a => ({
      id: a.id,
      supplyId: a.supplyId,
      cups: a.cups,
      type: a.type,
      severity: a.severity,
      message: a.message,
      detectedAt: a.detectedAt.toISOString(),
    }));

  const pendingApprovals =
    scope === 'PLATFORM' ? supplies.filter(s => s.status === 'PENDING_APPROVAL').length : 0;
  const clientCount =
    scope === 'PLATFORM' ? ((await prisma.client.findMany()) as unknown[]).length : 0;

  return {
    scope,
    generatedAt: new Date().toISOString(),
    totals: {
      activeSupplies: supplies.filter(s => s.status === 'ACTIVE').length,
      pendingSupplies: supplies.filter(s => s.status === 'PENDING_APPROVAL').length,
      inactiveSupplies: supplies.filter(s => s.status === 'INACTIVE').length,
      lastPeriodCostEur: anyLast ? lastCost : null,
      prevPeriodCostEur: anyPrev ? prevCost : null,
      lastPeriodKwh: anyLast ? lastKwh : null,
      openAlerts,
      openAlertsHigh,
      annualSavingEur: anySaving ? savingSum : null,
      carbonDeltaPct: co2Kwh > 0 ? co2Weighted / co2Kwh : null,
    },
    monthlyCost,
    recentAlerts,
    supplies: supplyRows,
    pendingApprovals,
    clientCount,
  };
}
