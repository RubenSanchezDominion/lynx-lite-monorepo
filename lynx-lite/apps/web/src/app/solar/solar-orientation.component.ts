import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { GraphqlService } from '../services/graphql.service';

const ACCENT = '#1565c0';
const MUTED = '#b7c2cf';

interface OrientationPoint {
  tilt: number;
  azimuth: number;
  label: string | null;
  annualSelfConsumptionKwh: number;
  selfConsumptionRatio: number;
  annualSavingEur: number;
  npvEur: number;
}
interface OrientationResult {
  recommended: OrientationPoint;
  candidates: OrientationPoint[];
}

const POINT = `tilt azimuth label annualSelfConsumptionKwh selfConsumptionRatio annualSavingEur npvEur`;
const OPTIMIZE_ORIENTATION = `query($i: OptimizeSolarOrientationInput!) {
  optimizeSolarOrientation(input: $i) {
    recommended { ${POINT} }
    candidates { ${POINT} }
  }
}`;

@Component({
  selector: 'app-solar-orientation',
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
          <label class="field">Potencia pico (kWp)<input type="number" [(ngModel)]="kwp" name="kwp" step="1" /></label>
          <label class="field">Pérdidas (%)<input type="number" [(ngModel)]="lossPct" name="loss" step="1" /></label>
          <label class="field">Coste (€/kWp)<input type="number" [(ngModel)]="costPerKwp" name="cost" step="50" /></label>
        </div>
        <label class="check"><input type="checkbox" [(ngModel)]="includeEastWestSplit" name="ew" /> Incluir E-O a dos aguas</label>

        <button type="button" class="link" (click)="showFin = !showFin">{{ showFin ? '▾' : '▸' }} Supuestos financieros</button>
        <div class="grid-inputs" *ngIf="showFin">
          <label class="field">Horizonte (años)<input type="number" [(ngModel)]="horizonYears" name="hy" step="1" /></label>
          <label class="field">Descuento (%)<input type="number" [(ngModel)]="discountRatePct" name="dr" step="0.5" /></label>
          <label class="field">Degradación (%/año)<input type="number" [(ngModel)]="degradationPctPerYear" name="deg" step="0.1" /></label>
          <label class="field">Escalado precio (%/año)<input type="number" [(ngModel)]="priceEscalationPctPerYear" name="esc" step="0.5" /></label>
        </div>

        <button (click)="run()" [disabled]="loading">{{ loading ? 'Calculando…' : '🧭 Orientar' }}</button>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué calcula?</h4>
        <p class="leg-desc">Compara orientaciones (Sur, SE, SO, Este, Oeste y <strong>E-O a dos aguas</strong>)
          y recomienda la que <strong>maximiza el VAN del autoconsumo</strong> contra tu curva real.</p>
        <p class="leg-desc muted">Sur maximiza kWh, pero el este-oeste casa mejor con perfiles de mañana y
          tarde. Una llamada a PVGIS por orientación distinta.</p>
      </aside>
    </div>

    <div class="card" *ngIf="result as r">
      <h3 class="t">Orientación recomendada <span class="muted">· {{ kwp }} kWp</span></h3>
      <div class="kpis">
        <div class="kpi good"><span class="kv">{{ labelOf(r.recommended) }}</span><span class="kl">orientación óptima</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.selfConsumptionRatio * 100 | number: '1.0-0' }} %</span><span class="kl">autoconsumo</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.annualSavingEur | number: '1.0-0' }} €</span><span class="kl">ahorro/año</span></div>
        <div class="kpi"><span class="kv">{{ r.recommended.npvEur | number: '1.0-0' }} €</span><span class="kl">VAN</span></div>
      </div>

      <div class="chart-wrap"><canvas #orientChart></canvas></div>

      <table class="grid">
        <thead><tr><th>Orientación</th><th class="num">Autoconsumo</th><th class="num">Ahorro €/año</th><th class="num">VAN €</th></tr></thead>
        <tbody>
          <tr *ngFor="let c of r.candidates" [class.rec]="isRecommended(c, r.recommended)">
            <td>{{ labelOf(c) }}</td>
            <td class="num">{{ c.selfConsumptionRatio * 100 | number: '1.0-0' }} %</td>
            <td class="num">{{ c.annualSavingEur | number: '1.0-0' }}</td>
            <td class="num">{{ c.npvEur | number: '1.0-0' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" *ngIf="!result && !loading">
      <p class="muted">Fija la potencia pico y pulsa <strong>Orientar</strong> para comparar orientaciones.</p>
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
      .check { display: block; font-size: 0.85rem; color: var(--text); margin-bottom: 12px; }
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
export class SolarOrientationComponent implements OnDestroy {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  supplyId = this.supplies[1].supplyId;
  lat = 41.65;
  lon = -0.88;
  kwp = 40;
  lossPct = 14;
  costPerKwp = 1000;
  includeEastWestSplit = true;

  showFin = false;
  horizonYears = 25;
  discountRatePct = 4;
  degradationPctPerYear = 0.5;
  priceEscalationPctPerYear = 0;

  loading = false;
  error = '';
  result: OrientationResult | null = null;

  @ViewChild('orientChart') orientChart?: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;

  constructor(private gql: GraphqlService) {}

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? '';
  }

  labelOf(c: OrientationPoint): string {
    return c.label ?? `${c.tilt}°/${c.azimuth}°`;
  }

  isRecommended(c: OrientationPoint, rec: OrientationPoint): boolean {
    return c.tilt === rec.tilt && c.azimuth === rec.azimuth && c.label === rec.label;
  }

  async run(): Promise<void> {
    this.error = '';
    this.loading = true;
    this.result = null;
    try {
      const data = await this.gql.request<{ optimizeSolarOrientation: OrientationResult }>(OPTIMIZE_ORIENTATION, {
        i: {
          cups: this.cups(),
          lat: this.lat,
          lon: this.lon,
          kwp: this.kwp,
          lossPct: this.lossPct,
          costPerKwp: this.costPerKwp,
          includeEastWestSplit: this.includeEastWestSplit,
          financial: {
            horizonYears: this.horizonYears,
            discountRatePct: this.discountRatePct,
            degradationPctPerYear: this.degradationPctPerYear,
            priceEscalationPctPerYear: this.priceEscalationPctPerYear,
          },
        },
      });
      this.result = data.optimizeSolarOrientation;
      setTimeout(() => this.renderChart(), 0);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private renderChart(): void {
    const r = this.result;
    const canvas = this.orientChart?.nativeElement;
    this.chart?.destroy();
    if (!r || !canvas) return;
    this.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: r.candidates.map(c => this.labelOf(c)),
        datasets: [
          {
            label: 'VAN (€)',
            data: r.candidates.map(c => c.npvEur),
            backgroundColor: r.candidates.map(c => (this.isRecommended(c, r.recommended) ? ACCENT : MUTED)),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { title: { display: true, text: 'VAN (€)' } } },
      },
    });
  }
}
