import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TopbarComponent } from '../shared/topbar.component';
import { GraphqlService } from '../services/graphql.service';

// SPECS §11 — Dashboard de inicio. Consume la query `dashboard` (solo datos persistidos,
// agregados según el rol del usuario). Sustituye la antigua maqueta con datos fijos.

interface Totals {
  activeSupplies: number; pendingSupplies: number; inactiveSupplies: number;
  lastPeriodCostEur: number | null; prevPeriodCostEur: number | null; lastPeriodKwh: number | null;
  openAlerts: number; openAlertsHigh: number; annualSavingEur: number | null; carbonDeltaPct: number | null;
}
interface MonthlyCostPoint { month: string; eur: number; }
interface DashAlert { id: string; supplyId: string; cups: string; type: string; severity: string; message: string; detectedAt: string; }
interface SupplyRow {
  id: string; cups: string; clientName: string | null; tariff: string; status: string;
  lastPeriod: string | null; lastKwh: number | null; lastCostEur: number | null;
  openAlerts: number; annualSavingEur: number | null; backfillStatus: string;
}
interface Dashboard {
  scope: 'PLATFORM' | 'CLIENT' | 'SUPPLY';
  generatedAt: string; totals: Totals; monthlyCost: MonthlyCostPoint[];
  recentAlerts: DashAlert[]; supplies: SupplyRow[]; pendingApprovals: number; clientCount: number;
}

const DASHBOARD_QUERY = `query {
  dashboard {
    scope generatedAt pendingApprovals clientCount
    totals {
      activeSupplies pendingSupplies inactiveSupplies
      lastPeriodCostEur prevPeriodCostEur lastPeriodKwh
      openAlerts openAlertsHigh annualSavingEur carbonDeltaPct
    }
    monthlyCost { month eur }
    recentAlerts { id supplyId cups type severity message detectedAt }
    supplies { id cups clientName tariff status lastPeriod lastKwh lastCostEur openAlerts annualSavingEur backfillStatus }
  }
}`;

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Activo', PENDING_APPROVAL: 'Pendiente', INACTIVE: 'Inactivo' };
const TARIFF_LABEL: Record<string, string> = { T_2_0TD: '2.0TD', T_3_0TD: '3.0TD' };

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, TopbarComponent],
  template: `
    <app-topbar section="Dashboard" />

    <div class="dash">
    <div class="card" *ngIf="loading">
      <p class="muted">Cargando el estado de tu empresa…</p>
    </div>

    <div class="card err" *ngIf="error">
      <p>No se pudo cargar el dashboard: {{ error }}</p>
    </div>

    <ng-container *ngIf="data && !loading">
      <!-- KPIs principales -->
      <div class="kpis">
        <div class="kpi" *ngFor="let k of kpis">
          <span class="kicon">{{ k.icon }}</span>
          <span class="kv">{{ k.value }}</span>
          <span class="kl">{{ k.label }}</span>
          <span class="kdelta" *ngIf="k.delta" [class.up]="k.up" [class.down]="!k.up">{{ k.up ? '▲' : '▼' }} {{ k.delta }}</span>
        </div>
      </div>

      <div class="row">
        <!-- Coste mensual (barras CSS) -->
        <div class="card chart">
          <h3 class="t">Coste energético (últimos meses)</h3>
          <div class="bars" *ngIf="data.monthlyCost.length; else noCost">
            <div class="bar-col" *ngFor="let m of bars">
              <div class="bar" [style.height.%]="m.pct"><span class="bar-val">{{ m.eur | number: '1.0-0' }}€</span></div>
              <span class="bar-lbl">{{ m.label }}</span>
            </div>
          </div>
          <ng-template #noCost><p class="muted empty">Aún no hay pre-facturas calculadas.</p></ng-template>
        </div>

        <!-- Alertas recientes -->
        <div class="card alerts">
          <div class="ahead">
            <h3 class="t">Alertas recientes</h3>
            <span class="abadge" *ngIf="data.totals.openAlerts" [class.crit]="data.totals.openAlertsHigh">
              {{ data.totals.openAlerts }} abiertas<ng-container *ngIf="data.totals.openAlertsHigh"> · {{ data.totals.openAlertsHigh }} críticas</ng-container>
            </span>
          </div>
          <ul class="alert-list" *ngIf="data.recentAlerts.length; else noAlerts">
            <li *ngFor="let a of data.recentAlerts" [class]="'sev-' + sev(a.severity)">
              <span class="dot"></span>
              <div class="a-body">
                <span class="a-title">{{ a.message }}</span>
                <span class="a-meta">{{ a.cups }} · {{ a.detectedAt | date: 'dd/MM HH:mm' }}</span>
              </div>
            </li>
          </ul>
          <ng-template #noAlerts><p class="muted empty">Sin alertas abiertas. 🎉</p></ng-template>
        </div>
      </div>

      <!-- Tabla de suministros -->
      <div class="card">
        <h3 class="t">Suministros</h3>
        <table *ngIf="data.supplies.length; else noSupplies">
          <thead><tr>
            <th>CUPS</th>
            <th *ngIf="data.scope !== 'SUPPLY'">Cliente</th>
            <th>Tarifa</th><th>Estado</th><th>Último periodo</th><th>Consumo</th><th>Coste</th><th>Alertas</th><th>Ahorro pot.</th>
          </tr></thead>
          <tbody>
            <tr *ngFor="let s of data.supplies">
              <td class="mono">{{ s.cups }}</td>
              <td *ngIf="data.scope !== 'SUPPLY'">{{ s.clientName || '—' }}</td>
              <td>{{ tariff(s.tariff) }}</td>
              <td><span class="pill" [class]="'st-' + s.status">{{ statusLabel(s.status) }}</span></td>
              <td>{{ s.lastPeriod || '—' }}</td>
              <td>{{ s.lastKwh != null ? (s.lastKwh | number: '1.0-0') + ' kWh' : '—' }}</td>
              <td>{{ s.lastCostEur != null ? (s.lastCostEur | number: '1.2-2') + ' €' : '—' }}</td>
              <td>{{ s.openAlerts }}</td>
              <td>{{ s.annualSavingEur != null ? (s.annualSavingEur | number: '1.0-0') + ' €/año' : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <ng-template #noSupplies><p class="muted empty">No hay suministros en tu cartera todavía.</p></ng-template>
      </div>
    </ng-container>
    </div>
  `,
  styles: [
    `
      /* Contenedor centrado de ancho fijo: alinea KPIs, gráficas y tabla al mismo eje. */
      .dash {
        max-width: 1240px;
        margin: 0 auto;
        padding: 22px 24px 48px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      /* Anula el auto-centrado/ancho del .card global dentro del dashboard. */
      .dash .card { max-width: none; margin: 0; padding: 18px 20px; border-radius: 14px; }

      .t { margin: 0 0 16px; font-size: 0.95rem; font-weight: 600; }
      .muted { color: var(--muted); }
      .empty { margin: 6px 0 0; font-size: 0.9rem; }
      .err { border-color: #f3b6ad; background: #fdecea; color: #a3271a; }
      .mono { font-family: ui-monospace, monospace; font-size: 0.82rem; }

      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }

      .ahead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; }
      .ahead .t { margin: 0; }
      .abadge {
        font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 999px;
        background: #eaf1fb; color: #15539e; white-space: nowrap;
      }
      .abadge.crit { background: #fdecea; color: #c0392b; }
      .kpi {
        background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px;
        position: relative; display: flex; flex-direction: column; gap: 2px; min-height: 96px;
        box-shadow: 0 1px 3px rgba(16, 42, 78, 0.05);
      }
      .kicon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; border-radius: 10px; background: #eaf1fb; font-size: 1.15rem; margin-bottom: 8px;
      }
      .kpi .kv { font-size: 1.55rem; font-weight: 700; color: #15539e; line-height: 1.1; }
      .kpi .kl { font-size: 0.78rem; color: var(--muted); }
      .kdelta { position: absolute; top: 16px; right: 16px; font-size: 0.78rem; font-weight: 600; }
      .kdelta.up { color: #1f9d55; }
      .kdelta.down { color: #c0392b; }

      .row { display: grid; grid-template-columns: 1.5fr 1fr; gap: 18px; align-items: stretch; }
      .chart .bars { display: flex; align-items: flex-end; gap: 20px; height: 210px; padding-top: 16px; }
      .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; max-width: 90px; }
      .bar { width: 100%; background: linear-gradient(180deg, #4a90ed, #15539e); border-radius: 8px 8px 0 0; position: relative; min-height: 4px; transition: height 0.4s ease; }
      .bar-val { position: absolute; top: -20px; left: 50%; transform: translateX(-50%); font-size: 0.74rem; font-weight: 600; color: var(--text); white-space: nowrap; }
      .bar-lbl { margin-top: 10px; font-size: 0.76rem; color: var(--muted); }

      .alert-list { list-style: none; margin: 0; padding: 0; }
      .alert-list li { display: flex; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--border); }
      .alert-list li:first-child { padding-top: 0; }
      .alert-list li:last-child { border-bottom: 0; padding-bottom: 0; }
      .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; flex: 0 0 9px; }
      .sev-high .dot { background: #c0392b; }
      .sev-medium .dot { background: #e0a100; }
      .sev-low .dot { background: #2f80ed; }
      .a-title { display: block; font-size: 0.88rem; }
      .a-meta { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }

      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 0.86rem; }
      th { color: var(--muted); font-weight: 600; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.3px; }
      tbody tr:last-child td { border-bottom: 0; }
      tbody tr:hover { background: #f7f9fc; }
      .pill { font-size: 0.74rem; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
      .st-ACTIVE { background: #e3f6ec; color: #1f7a4d; }
      .st-PENDING_APPROVAL { background: #fef6dd; color: #8a6d00; }
      .st-INACTIVE { background: #f0f0f0; color: #777; }

      @media (max-width: 1080px) { .kpis { grid-template-columns: repeat(3, 1fr); } }
      @media (max-width: 820px) {
        .kpis { grid-template-columns: repeat(2, 1fr); }
        .row { grid-template-columns: 1fr; }
      }
    `,
  ],
})
export class DashboardComponent implements OnInit {
  loading = true;
  error: string | null = null;
  data: Dashboard | null = null;
  kpis: { icon: string; value: string; label: string; delta?: string; up?: boolean }[] = [];
  bars: { label: string; eur: number; pct: number }[] = [];

  constructor(private gql: GraphqlService) {}

  async ngOnInit(): Promise<void> {
    try {
      const res = await this.gql.request<{ dashboard: Dashboard }>(DASHBOARD_QUERY);
      this.data = res.dashboard;
      this.buildKpis();
      this.buildBars();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  sev(severity: string): 'high' | 'medium' | 'low' {
    if (severity === 'CRITICAL') return 'high';
    if (severity === 'WARNING') return 'medium';
    return 'low';
  }
  statusLabel(s: string): string { return STATUS_LABEL[s] ?? s; }
  tariff(t: string): string { return TARIFF_LABEL[t] ?? t; }

  private nf(n: number, dec = 0): string {
    return n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  private buildKpis(): void {
    const t = this.data!.totals;

    let costDelta: string | undefined; let costUp = false;
    if (t.lastPeriodCostEur != null && t.prevPeriodCostEur != null && t.prevPeriodCostEur !== 0) {
      const pct = ((t.lastPeriodCostEur - t.prevPeriodCostEur) / t.prevPeriodCostEur) * 100;
      costDelta = `${this.nf(Math.abs(pct), 1)} %`;
      costUp = pct < 0; // bajar el coste es bueno → flecha verde
    }

    // Cuatro indicadores de cabecera (una sola línea). Las alertas viven en su propio panel.
    this.kpis = [
      { icon: '💶', value: t.lastPeriodCostEur != null ? `${this.nf(t.lastPeriodCostEur)} €` : '—', label: 'Coste último periodo', delta: costDelta, up: costUp },
      { icon: '⚡', value: t.lastPeriodKwh != null ? `${this.nf(t.lastPeriodKwh)} kWh` : '—', label: 'Consumo último periodo' },
      { icon: '🏭', value: String(t.activeSupplies), label: 'Suministros activos' },
      { icon: '💡', value: t.annualSavingEur != null ? `${this.nf(t.annualSavingEur)} €/año` : '—', label: 'Ahorro potencial' },
    ];
  }

  private buildBars(): void {
    const points = this.data!.monthlyCost;
    const max = Math.max(1, ...points.map(p => p.eur));
    this.bars = points.map(p => {
      const [y, m] = p.month.split('-');
      const label = `${MONTHS_ES[Number(m) - 1] ?? p.month} ${y.slice(2)}`;
      return { label, eur: p.eur, pct: Math.round((p.eur / max) * 100) };
    });
  }
}
