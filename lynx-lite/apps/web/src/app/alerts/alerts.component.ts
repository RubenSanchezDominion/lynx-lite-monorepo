import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface Alert {
  id: string;
  type: 'ZSCORE' | 'PHANTOM' | 'LIMIT' | 'ESTIMATED';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: 'NEW' | 'ACKNOWLEDGED' | 'DISMISSED';
  windowStart: string;
  message: string;
}

interface InactivityWindow { days: number[]; from: string; to: string; }
interface AlertConfig {
  enabled: boolean;
  sensitivity: 'CONSERVADOR' | 'EQUILIBRADO' | 'AGRESIVO';
  enabledTypes: string[];
  // Se conservan del config cargado y se reenvían al guardar (no se editan en esta pantalla):
  limitThresholdPct: number;
  phantomThresholdKwh: number;
  inactivityWindows: InactivityWindow[];
}

// Catálogo de tipos: nombre claro + qué detecta. Única fuente para leyenda, ajustes y lista.
const TYPES: { key: string; label: string; desc: string }[] = [
  { key: 'ZSCORE', label: 'Anomalía', desc: 'Consumo muy fuera de lo normal para esa hora y día.' },
  { key: 'PHANTOM', label: 'Consumo fantasma', desc: 'Gasto cuando la instalación debería estar parada.' },
  { key: 'LIMIT', label: 'Cerca del límite', desc: 'La potencia roza el máximo contratado.' },
  { key: 'ESTIMATED', label: 'Dato estimado', desc: 'Lectura no real, estimada por la distribuidora.' },
];
const LABEL = Object.fromEntries(TYPES.map(t => [t.key, t.label]));

const CFG_FIELDS = `enabled sensitivity enabledTypes limitThresholdPct phantomThresholdKwh inactivityWindows { days from to }`;
const LIST = `query($s: String!) { alerts(supplyId: $s) { id type severity status windowStart message } }`;
const CFG = `query($s: String!) { alertConfig(supplyId: $s) { ${CFG_FIELDS} } }`;
const EVAL = `mutation($i: EvaluateAlertsInput!) { evaluateAlerts(input: $i) { id } }`;
const ACK = `mutation($id: ID!) { acknowledgeAlert(id: $id) { id status } }`;
const DISMISS = `mutation($id: ID!) { dismissAlert(id: $id) { id status } }`;
const SAVE_CFG = `mutation($i: AlertConfigInput!) { saveAlertConfig(input: $i) { ${CFG_FIELDS} } }`;

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Alertas y anomalías (M03)" />

    <!-- Card 1: suministro + ajustes (izquierda) y leyenda (derecha) -->
    <div class="card panel" *ngIf="config as c">
      <div class="main">
        <label class="field">Suministro
          <select [(ngModel)]="cups" name="cups" (ngModelChange)="onCupsChange()">
            <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
          </select>
        </label>

        <label class="field">¿Cuántas alarmas quieres?
          <select [(ngModel)]="c.sensitivity" name="sens">
            <option value="CONSERVADOR">Pocas — solo lo evidente</option>
            <option value="EQUILIBRADO">Equilibrado (recomendado)</option>
            <option value="AGRESIVO">Muchas — detecta hasta lo dudoso</option>
          </select>
        </label>

        <div class="field">
          <span class="lbl">¿Qué alarmas activar?</span>
          <div class="toggles">
            <button type="button" class="tg" *ngFor="let t of types"
                    [class.on]="c.enabledTypes.includes(t.key)" (click)="toggleType(t.key)">
              <span class="dot"></span>{{ t.label }}
            </button>
          </div>
        </div>

        <div class="actions">
          <button (click)="evaluate()" [disabled]="loading">{{ loading ? 'Analizando…' : '🔎 Analizar último día' }}</button>
          <span class="hint">Aplica los ajustes y muestra solo los tipos activos.</span>
        </div>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué es cada alarma?</h4>
        <div class="leg" *ngFor="let t of types">
          <span class="badge" [ngClass]="t.key.toLowerCase()">{{ t.label }}</span>
          <span class="leg-desc">{{ t.desc }}</span>
        </div>
      </aside>
    </div>

    <!-- Card 2: alarmas encontradas -->
    <div class="card">
      <h3 class="t">Alarmas encontradas <span class="muted" *ngIf="alerts.length">({{ alerts.length }})</span></h3>
      <ng-container *ngIf="alerts.length; else none">
        <div class="alert-row" *ngFor="let a of alerts" [ngClass]="a.type.toLowerCase()">
          <span class="stripe"></span>
          <div class="a-main">
            <div class="a-head">
              <span class="badge" [ngClass]="a.type.toLowerCase()">{{ label(a.type) }}</span>
              <span class="when">{{ fmt(a.windowStart) }}</span>
              <span class="stpill" *ngIf="a.status !== 'NEW'" [ngClass]="a.status.toLowerCase()">{{ statusLabel(a.status) }}</span>
            </div>
            <div class="a-msg">{{ a.message }}</div>
          </div>
          <div class="a-actions" *ngIf="a.status === 'NEW'">
            <button class="mini" (click)="ack(a)">Vista</button>
            <button class="mini ghost" (click)="dismiss(a)">Descartar</button>
          </div>
        </div>
      </ng-container>
      <ng-template #none>
        <p class="muted">{{ loading ? 'Analizando…' : 'Pulsa «Analizar último día» para revisar el consumo más reciente.' }}</p>
      </ng-template>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 12px; font-size: 1rem; }
      .muted { color: var(--muted); font-weight: 400; }

      /* Card 1: dos columnas (ajustes | leyenda) */
      .panel { display: flex; gap: 24px; align-items: flex-start; }
      .main { flex: 1; min-width: 0; }
      .field { margin-bottom: 16px; }
      .field .lbl { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 8px; }
      select { max-width: 340px; }
      .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .actions .hint { font-size: 0.78rem; color: var(--muted); }

      .toggles { display: flex; flex-wrap: wrap; gap: 8px; }
      .tg { display: flex; align-items: center; gap: 8px; background: var(--bg); color: var(--muted);
            border: 1px solid var(--border); border-radius: 8px; padding: 7px 13px; font-size: 0.85rem; font-weight: 600; }
      .tg .dot { width: 9px; height: 9px; border-radius: 50%; background: #c3cbd4; }
      .tg.on { background: #eaf3ec; color: #1e7e34; border-color: #b6dcc0; }
      .tg.on .dot { background: #2e9e4f; }

      /* Leyenda lateral compacta */
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .aside h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .leg { margin-bottom: 10px; }
      .leg .leg-desc { display: block; font-size: 0.78rem; color: var(--muted); margin-top: 3px; }

      .badge { font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; color: #fff; white-space: nowrap; }
      .badge.zscore { background: #15539e; }            /* azul oscuro */
      .badge.phantom { background: #2a93d5; }           /* azul medio */
      .badge.limit { background: #e0a100; color: #3a2e00; }   /* ámbar */
      .badge.estimated { background: #f4d77a; color: #5a4500; } /* amarillo suave */

      /* Card 2: lista */
      .alert-row { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
      .alert-row:last-child { border-bottom: 0; }
      .stripe { width: 4px; border-radius: 4px; flex: 0 0 4px; background: var(--muted); }
      .alert-row.zscore .stripe { background: #15539e; }
      .alert-row.phantom .stripe { background: #2a93d5; }
      .alert-row.limit .stripe { background: #e0a100; }
      .alert-row.estimated .stripe { background: #f4d77a; }
      .a-main { flex: 1; }
      .a-head { display: flex; align-items: center; gap: 10px; }
      .when { font-size: 0.82rem; color: var(--muted); }
      .a-msg { font-size: 0.9rem; margin-top: 4px; }
      .stpill { font-size: 0.72rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
      .stpill.acknowledged { background: #e6f4ea; color: #1e7e34; }
      .stpill.dismissed { background: #eceff3; color: #6b7785; }
      .a-actions { display: flex; align-items: center; gap: 6px; }
      .mini { font-size: 0.8rem; padding: 6px 12px; }
      .mini.ghost { background: none; color: var(--accent); border: 1px solid var(--border); }

      @media (max-width: 720px) {
        .panel { flex-direction: column; }
        .aside { width: auto; flex: none; border-left: 0; border-top: 1px solid var(--border); padding: 16px 0 0; }
      }
    `,
  ],
})
export class AlertsComponent implements OnInit {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  cups = this.supplies[1].cups;
  supplyId = this.supplies[1].supplyId;

  types = TYPES;
  loading = false;
  error = '';
  alerts: Alert[] = [];
  config: AlertConfig | null = null;

  constructor(private gql: GraphqlService) {}

  ngOnInit(): void {
    void this.loadConfig();
    // La lista arranca vacía: el usuario pulsa «Analizar» para verla.
  }

  onCupsChange(): void {
    this.supplyId = this.supplies.find(s => s.cups === this.cups)?.supplyId ?? this.supplyId;
    this.alerts = []; // al cambiar de suministro se vacía: hay que volver a Analizar
    void this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    try {
      const data = await this.gql.request<{ alertConfig: AlertConfig | null }>(CFG, { s: this.supplyId });
      this.config = data.alertConfig ?? this.defaultConfig();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  // Aplica los ajustes elegidos (sensibilidad + tipos), analiza el último día y muestra SOLO
  // las alarmas de los tipos activos (descarta las persistidas de tipos ahora desactivados).
  async evaluate(): Promise<void> {
    if (!this.config) return;
    this.error = '';
    this.loading = true;
    try {
      await this.persistConfig();
      await this.gql.request(EVAL, { i: { cups: this.cups } });
      const data = await this.gql.request<{ alerts: Alert[] }>(LIST, { s: this.supplyId });
      const active = new Set(this.config.enabledTypes);
      this.alerts = data.alerts.filter(a => active.has(a.type));
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  async ack(a: Alert): Promise<void> {
    try {
      const r = await this.gql.request<{ acknowledgeAlert: { status: Alert['status'] } }>(ACK, { id: a.id });
      a.status = r.acknowledgeAlert.status;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async dismiss(a: Alert): Promise<void> {
    try {
      const r = await this.gql.request<{ dismissAlert: { status: Alert['status'] } }>(DISMISS, { id: a.id });
      a.status = r.dismissAlert.status;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  // Persiste los ajustes actuales antes de analizar. Reenvía umbrales y franjas tal cual venían
  // (no se editan aquí) para no perder, p. ej., las franjas que necesita «Consumo fantasma».
  private async persistConfig(): Promise<void> {
    if (!this.config) return;
    const c = this.config;
    const data = await this.gql.request<{ saveAlertConfig: AlertConfig }>(SAVE_CFG, {
      i: {
        cups: this.cups,
        enabled: true,
        sensitivity: c.sensitivity,
        enabledTypes: c.enabledTypes,
        limitThresholdPct: c.limitThresholdPct,
        phantomThresholdKwh: c.phantomThresholdKwh,
        inactivityWindows: c.inactivityWindows.map(w => ({ days: w.days, from: w.from, to: w.to })),
      },
    });
    this.config = data.saveAlertConfig;
  }

  toggleType(key: string): void {
    if (!this.config) return;
    const set = this.config.enabledTypes;
    const i = set.indexOf(key);
    if (i >= 0) set.splice(i, 1);
    else set.push(key);
  }

  fmt(ts: string): string {
    return new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  label(t: string): string {
    return LABEL[t] ?? t;
  }
  statusLabel(s: string): string {
    return ({ ACKNOWLEDGED: 'Vista', DISMISSED: 'Descartada' } as Record<string, string>)[s] ?? s;
  }

  private defaultConfig(): AlertConfig {
    return {
      enabled: true,
      sensitivity: 'EQUILIBRADO',
      enabledTypes: TYPES.map(t => t.key),
      limitThresholdPct: 0.95,
      phantomThresholdKwh: 1,
      inactivityWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '06:00' }],
    };
  }
}
