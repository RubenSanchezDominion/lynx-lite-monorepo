import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { GraphqlService } from '../services/graphql.service';

const ACCENT = '#1565c0';
const MUTED = '#b7c2cf';

interface SizingPoint {
  kwp: number;
  annualSavingEur: number;
  npvEur: number;
  paybackYears: number | null;
  selfConsumptionRatio: number;
}
interface SizingResult {
  recommendedKwp: number;
  recommended: SizingPoint;
  curve: SizingPoint[];
  horizonYears: number;
  discountRatePct: number;
}

const POINT = `kwp annualSavingEur npvEur paybackYears selfConsumptionRatio`;
const OPTIMIZE_SIZING = `query($i: OptimizeSolarSizingInput!) {
  optimizeSolarSizing(input: $i) {
    recommendedKwp horizonYears discountRatePct
    recommended { ${POINT} }
    curve { ${POINT} }
  }
}`;

@Component({
  selector: 'app-solar-sizing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="card panel">
      <div class="main">
        <label class="field">Suministro
          <select [(ngModel)]="supplyId" name="supply">
            <option *ngFor="let s of supplies" [value]="s.supplyId">{{ s.label }}</option>
          </select>
        </label>

        <div class="grid-inputs">
          <label class="field">Latitud<input type="number" [(ngModel)]="lat" name="lat" step="0.01" /></label>
          <label class="field">Longitud<input type="number" [(ngModel)]="lon" name="lon" step="0.01" /></label>
          <label class="field">kWp mínimo<input type="number" [(ngModel)]="kwpMin" name="kwpMin" step="1" /></label>
          <label class="field">kWp máximo<input type="number" [(ngModel)]="kwpMax" name="kwpMax" step="1" /></label>
          <label class="field">Paso (kWp)<input type="number" [(ngModel)]="kwpStep" name="kwpStep" step="1" /></label>
          <label class="field">Inclinación (°)<input type="number" [(ngModel)]="tilt" name="tilt" step="1" /></label>
          <label class="field">Orientación (°)<input type="number" [(ngModel)]="azimuth" name="azimuth" step="1" /></label>
          <label class="field">Pérdidas (%)<input type="number" [(ngModel)]="lossPct" name="loss" step="1" /></label>
          <label class="field">Coste (€/kWp)<input type="number" [(ngModel)]="costPerKwp" name="cost" step="50" /></label>
          <label class="field">Presup. máx (€)<input type="number" [(ngModel)]="maxBudgetEur" name="budget" step="1000" placeholder="sin límite" /></label>
        </div>

        <button type="button" class="link" (click)="showFin = !showFin">{{ showFin ? '▾' : '▸' }} Supuestos financieros</button>
        <div class="grid-inputs" *ngIf="showFin">
          <label class="field">Horizonte (años)<input type="number" [(ngModel)]="horizonYears" name="hy" step="1" /></label>
          <label class="field">Descuento (%)<input type="number" [(ngModel)]="discountRatePct" name="dr" step="0.5" /></label>
          <label class="field">Degradación (%/año)<input type="number" [(ngModel)]="degradationPctPerYear" name="deg" step="0.1" /></label>
          <label class="field">Escalado precio (%/año)<input type="number" [(ngModel)]="priceEscalationPctPerYear" name="esc" step="0.5" /></label>
        </div>

        <button (click)="run()" [disabled]="loading">{{ loading ? 'Calculando…' : '📐 Dimensionar' }}</button>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué calcula?</h4>
        <p class="leg-desc">Barre tamaños de planta y devuelve la <strong>curva de VAN vs kWp</strong>,
          marcando el óptimo económico (el que maximiza el VAN a {{ horizonYears }} años).</p>
        <p class="leg-desc muted">Una sola llamada a PVGIS: la producción escala con el kWp. El VAN
          depende de los supuestos financieros (orientativo).</p>
      </aside>
    </div>

    <div class="card" *ngIf="result as r">
      <h3 class="t">Óptimo <span class="muted">· VAN a {{ r.horizonYears }} años, descuento {{ r.discountRatePct }} %</span></h3>
      <div class="kpis">
        <div class="kpi good"><span class="kv">{{ r.recommendedKwp | number: '1.0-1' }} kWp</span><span class="kl">tamaño recomendado</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.npvEur | number: '1.0-0' }} €</span><span class="kl">VAN</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.paybackYears != null ? (r.recommended.paybackYears | number: '1.1-1') + ' años' : 'n/a' }}</span><span class="kl">payback</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.selfConsumptionRatio * 100 | number: '1.0-0' }} %</span><span class="kl">autoconsumo</span></div>
      </div>

      <div class="chart-wrap"><canvas #sizeChart></canvas></div>

      <table class="grid">
        <thead><tr><th>kWp</th><th class="num">VAN €</th><th class="num">Ahorro €/año</th><th class="num">Payback</th><th class="num">Autoconsumo</th></tr></thead>
        <tbody>
          <tr *ngFor="let p of r.curve" [class.rec]="p.kwp === r.recommendedKwp">
            <td>{{ p.kwp | number: '1.0-1' }}</td>
            <td class="num">{{ p.npvEur | number: '1.0-0' }}</td>
            <td class="num">{{ p.annualSavingEur | number: '1.0-0' }}</td>
            <td class="num">{{ p.paybackYears != null ? (p.paybackYears | number: '1.1-1') : '—' }}</td>
            <td class="num">{{ p.selfConsumptionRatio * 100 | number: '1.0-0' }} %</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" *ngIf="!result && !loading">
      <p class="muted">Fija el rango de kWp y pulsa <strong>Dimensionar</strong> para ver la curva de VAN.</p>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 12px; font-size: 1rem; }
      .muted { color: var(--muted); font-weight: 400; }
      .panel { display: flex; gap: 24px; align-items: flex-start; }
      .main { flex: 1; min-width: 0; }
      .field { margin-bottom: 12px; display: block; font-size: 0.85rem; color: var(--muted); }
      .field input, .field select { display: block; margin-top: 4px; }
      .grid-inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 16px; margin-bottom: 12px; }
      input[type=number], select { max-width: 200px; }
      button.link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0 0 12px; font-size: 0.82rem; }
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .aside h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .leg-desc { font-size: 0.82rem; margin: 0 0 10px; }
      .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
      .kpi { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; min-width: 120px; }
      .kpi .kv { display: block; font-size: 1.2rem; font-weight: 700; color: #15539e; }
      .kpi .kl { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }
      .kpi.good .kv { color: #1e8e3e; }
      .chart-wrap { position: relative; height: 300px; margin-bottom: 16px; }
      table.grid { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
      .grid th, .grid td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
      .grid th { font-size: 0.76rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      tr.rec { background: #e8f0fe; font-weight: 600; }
      .error { color: #c0392b; }
      @media (max-width: 720px) {
        .panel { flex-direction: column; }
        .aside { width: auto; flex: none; border-left: 0; border-top: 1px solid var(--border); padding: 16px 0 0; }
      }
    `,
  ],
})
export class SolarSizingComponent implements OnDestroy {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  supplyId = this.supplies[1].supplyId;
  lat = 41.65;
  lon = -0.88;
  kwpMin = 5;
  kwpMax = 100;
  kwpStep = 5;
  tilt = 35;
  azimuth = 0;
  lossPct = 14;
  costPerKwp = 1000;
  maxBudgetEur: number | null = null;

  showFin = false;
  horizonYears = 25;
  discountRatePct = 4;
  degradationPctPerYear = 0.5;
  priceEscalationPctPerYear = 0;

  loading = false;
  error = '';
  result: SizingResult | null = null;

  @ViewChild('sizeChart') sizeChart?: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;

  constructor(private gql: GraphqlService) {}

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? '';
  }

  async run(): Promise<void> {
    this.error = '';
    this.loading = true;
    this.result = null;
    try {
      const data = await this.gql.request<{ optimizeSolarSizing: SizingResult }>(OPTIMIZE_SIZING, {
        i: {
          cups: this.cups(),
          lat: this.lat,
          lon: this.lon,
          kwpMin: this.kwpMin,
          kwpMax: this.kwpMax,
          kwpStep: this.kwpStep,
          tilt: this.tilt,
          azimuth: this.azimuth,
          lossPct: this.lossPct,
          costPerKwp: this.costPerKwp,
          maxBudgetEur: this.maxBudgetEur,
          financial: {
            horizonYears: this.horizonYears,
            discountRatePct: this.discountRatePct,
            degradationPctPerYear: this.degradationPctPerYear,
            priceEscalationPctPerYear: this.priceEscalationPctPerYear,
          },
        },
      });
      this.result = data.optimizeSolarSizing;
      setTimeout(() => this.renderChart(), 0);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private renderChart(): void {
    const r = this.result;
    const canvas = this.sizeChart?.nativeElement;
    this.chart?.destroy();
    if (!r || !canvas) return;
    const recIdx = r.curve.findIndex(p => p.kwp === r.recommendedKwp);
    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: r.curve.map(p => p.kwp),
        datasets: [
          {
            label: 'VAN (€)',
            data: r.curve.map(p => p.npvEur),
            borderColor: ACCENT,
            backgroundColor: 'rgba(21,101,192,0.08)',
            fill: true,
            tension: 0.25,
            pointRadius: r.curve.map((_, i) => (i === recIdx ? 6 : 2)),
            pointBackgroundColor: r.curve.map((_, i) => (i === recIdx ? '#1e8e3e' : MUTED)),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'kWp instalados' } },
          y: { title: { display: true, text: 'VAN (€)' } },
        },
      },
    });
  }
}
