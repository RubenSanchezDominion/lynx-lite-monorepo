import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface Line {
  concept: string;
  period: number | null;
  quantity: number;
  unit: string;
  amount: number;
}
interface PreInvoice {
  tariff: string;
  powerTerm: number;
  energyTerm: number;
  excessPower: number;
  reactiveEnergy: number | null;
  meterRental: number;
  ieeAmount: number;
  vatAmount: number;
  total: number;
  gapHoursCount: number;
  lines: Line[];
}
interface ComparisonDelta {
  totalA: number;
  totalB: number;
  deltaTotal: number;
  deltaTotalPct: number | null;
  powerTermDelta: number;
  energyTermDelta: number;
  excessPowerDelta: number;
  reactiveDelta: number | null;
  meterRentalDelta: number;
  taxesDelta: number;
  kwhA: number;
  kwhB: number;
  avgCostPerKwhA: number | null;
  avgCostPerKwhB: number | null;
  deltaCostPerKwh: number | null;
  sameTariff: boolean;
}
interface ComparisonResult {
  a: PreInvoice;
  b: PreInvoice;
  delta: ComparisonDelta;
}

const PI = `tariff powerTerm energyTerm excessPower reactiveEnergy meterRental
  ieeAmount vatAmount total gapHoursCount
  lines { concept period quantity unit amount }`;
const COMPARE = `query($i: ComparisonInput!) {
  calculateComparison(input: $i) {
    a { ${PI} }
    b { ${PI} }
    delta {
      totalA totalB deltaTotal deltaTotalPct
      powerTermDelta energyTermDelta excessPowerDelta reactiveDelta
      meterRentalDelta taxesDelta kwhA kwhB
      avgCostPerKwhA avgCostPerKwhB deltaCostPerKwh sameTariff
    }
  }
}`;

const ACCENT = '#1565c0';
const ACCENT_B = '#90caf9';

@Component({
  selector: 'app-comparison',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Comparativa (M07)" />

    <div class="card">
      <!-- Modo de comparación -->
      <div class="seg">
        <button [class.on]="mode === 'months'" (click)="setMode('months')">Comparar periodos</button>
        <button [class.on]="mode === 'cups'" (click)="setMode('cups')">Comparar suministros</button>
      </div>

      <div class="sides">
        <!-- Lado A: solo el elemento que difiere -->
        <div class="side">
          <h4>{{ mode === 'cups' ? 'Suministro A' : 'Periodo A' }}</h4>
          <label *ngIf="mode === 'cups'">Suministro
            <select [(ngModel)]="cupsA" name="cupsA">
              <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
            </select>
          </label>
          <ng-container *ngIf="mode === 'months'" [ngTemplateOutlet]="periodPicker" [ngTemplateOutletContext]="{ side: 'A' }"></ng-container>
        </div>

        <!-- Lado B: solo el elemento que difiere -->
        <div class="side">
          <h4>{{ mode === 'cups' ? 'Suministro B' : 'Periodo B' }}</h4>
          <label *ngIf="mode === 'cups'">Suministro
            <select [(ngModel)]="cupsB" name="cupsB">
              <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
            </select>
          </label>
          <ng-container *ngIf="mode === 'months'" [ngTemplateOutlet]="periodPicker" [ngTemplateOutletContext]="{ side: 'B' }"></ng-container>
        </div>
      </div>

      <!-- Elemento común a A y B -->
      <div class="common">
        <h4>{{ mode === 'cups' ? 'Periodo' : 'Suministro' }}</h4>
        <select *ngIf="mode === 'months'" [(ngModel)]="cupsA" name="cupsCommon">
          <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
        </select>
        <ng-container *ngIf="mode === 'cups'" [ngTemplateOutlet]="periodPicker" [ngTemplateOutletContext]="{ side: 'A' }"></ng-container>
      </div>

      <div class="form-row">
        <label class="chk">
          <input type="checkbox" [(ngModel)]="freeRange" name="freeRange" />
          Rango de fechas libre
        </label>
        <button (click)="compare()" [disabled]="loading">{{ loading ? 'Comparando…' : 'Comparar' }}</button>
      </div>
      <p class="error" *ngIf="error">{{ error }}</p>
    </div>

    <!-- Plantilla de selección de periodo (mes/año o rango) -->
    <ng-template #periodPicker let-side="side">
      <ng-container *ngIf="!freeRange; else range">
        <div class="row2">
          <label>Mes
            <select [ngModel]="month(side)" (ngModelChange)="setMonth(side, $event)" [name]="'m' + side">
              <option *ngFor="let m of months; let i = index" [value]="i + 1">{{ m }}</option>
            </select>
          </label>
          <label>Año
            <select [ngModel]="year(side)" (ngModelChange)="setYear(side, $event)" [name]="'y' + side">
              <option *ngFor="let y of years" [value]="y">{{ y }}</option>
            </select>
          </label>
        </div>
      </ng-container>
      <ng-template #range>
        <div class="row2">
          <label>Desde<input type="date" [ngModel]="from(side)" (ngModelChange)="setFrom(side, $event)" [name]="'f' + side" /></label>
          <label>Hasta<input type="date" [ngModel]="to(side)" (ngModelChange)="setTo(side, $event)" [name]="'t' + side" /></label>
        </div>
      </ng-template>
    </ng-template>

    <div class="card" *ngIf="result as r">
      <div class="banner" *ngIf="r.a.gapHoursCount > 0 || r.b.gapHoursCount > 0">
        ⚠️ La comparación incluye horas con datos estimados o no disponibles
        (A: {{ r.a.gapHoursCount }} h, B: {{ r.b.gapHoursCount }} h). Cifras orientativas.
      </div>

      <!-- Badges de delta -->
      <div class="badges">
        <div class="badge" [class.up]="r.delta.deltaTotal > 0" [class.down]="r.delta.deltaTotal < 0">
          <span class="bv">{{ r.delta.deltaTotal > 0 ? '▲' : r.delta.deltaTotal < 0 ? '▼' : '=' }}
            {{ r.delta.deltaTotal | number: '1.2-2' }} €</span>
          <span class="bl">diferencia total (B − A)</span>
        </div>
        <div class="badge" *ngIf="r.delta.deltaTotalPct != null" [class.up]="r.delta.deltaTotal > 0" [class.down]="r.delta.deltaTotal < 0">
          <span class="bv">{{ r.delta.deltaTotalPct | number: '1.1-1' }} %</span>
          <span class="bl">variación sobre A</span>
        </div>
        <div class="badge" *ngIf="r.delta.deltaCostPerKwh != null" [class.up]="r.delta.deltaCostPerKwh > 0" [class.down]="r.delta.deltaCostPerKwh < 0">
          <span class="bv">{{ r.delta.deltaCostPerKwh | number: '1.4-4' }} €/kWh</span>
          <span class="bl">Δ coste unitario</span>
        </div>
      </div>

      <!-- Gráfica principal: importes por concepto -->
      <div class="chart-wrap"><canvas #barChart></canvas></div>

      <!-- Gráfica secundaria: P1–P6 (misma tarifa) o €/kWh (tarifas distintas) -->
      <h4 class="ct">{{ r.delta.sameTariff ? 'Energía por período (€)' : 'Coste medio (€/kWh)' }}</h4>
      <div class="chart-wrap"><canvas #secondChart></canvas></div>
      <p class="muted small" *ngIf="!r.delta.sameTariff">
        Tarifas distintas ({{ tar(r.a.tariff) }} vs {{ tar(r.b.tariff) }}): el desglose por período no es
        comparable; se muestra el coste medio normalizado.
      </p>

      <!-- Tabla A | B | Δ -->
      <table>
        <thead><tr><th>Concepto</th><th class="num">A</th><th class="num">B</th><th class="num">Δ (B − A)</th></tr></thead>
        <tbody>
          <tr><td>Término potencia</td><td class="num">{{ r.a.powerTerm | number: '1.2-2' }}</td><td class="num">{{ r.b.powerTerm | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.powerTermDelta > 0" [class.neg]="r.delta.powerTermDelta < 0">{{ r.delta.powerTermDelta | number: '1.2-2' }}</td></tr>
          <tr><td>Término energía</td><td class="num">{{ r.a.energyTerm | number: '1.2-2' }}</td><td class="num">{{ r.b.energyTerm | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.energyTermDelta > 0" [class.neg]="r.delta.energyTermDelta < 0">{{ r.delta.energyTermDelta | number: '1.2-2' }}</td></tr>
          <tr *ngIf="r.a.excessPower > 0 || r.b.excessPower > 0"><td>Exceso potencia</td><td class="num">{{ r.a.excessPower | number: '1.2-2' }}</td><td class="num">{{ r.b.excessPower | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.excessPowerDelta > 0" [class.neg]="r.delta.excessPowerDelta < 0">{{ r.delta.excessPowerDelta | number: '1.2-2' }}</td></tr>
          <tr *ngIf="r.delta.reactiveDelta != null"><td>Energía reactiva</td><td class="num">{{ r.a.reactiveEnergy | number: '1.2-2' }}</td><td class="num">{{ r.b.reactiveEnergy | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.reactiveDelta > 0" [class.neg]="r.delta.reactiveDelta < 0">{{ r.delta.reactiveDelta | number: '1.2-2' }}</td></tr>
          <tr><td>Alquiler contador</td><td class="num">{{ r.a.meterRental | number: '1.2-2' }}</td><td class="num">{{ r.b.meterRental | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.meterRentalDelta > 0" [class.neg]="r.delta.meterRentalDelta < 0">{{ r.delta.meterRentalDelta | number: '1.2-2' }}</td></tr>
          <tr><td>Impuestos (IEE + IVA)</td><td class="num">{{ r.a.ieeAmount + r.a.vatAmount | number: '1.2-2' }}</td><td class="num">{{ r.b.ieeAmount + r.b.vatAmount | number: '1.2-2' }}</td><td class="num" [class.pos]="r.delta.taxesDelta > 0" [class.neg]="r.delta.taxesDelta < 0">{{ r.delta.taxesDelta | number: '1.2-2' }}</td></tr>
          <tr class="grand"><td>TOTAL</td><td class="num">{{ r.delta.totalA | number: '1.2-2' }} €</td><td class="num">{{ r.delta.totalB | number: '1.2-2' }} €</td><td class="num" [class.pos]="r.delta.deltaTotal > 0" [class.neg]="r.delta.deltaTotal < 0">{{ r.delta.deltaTotal | number: '1.2-2' }} €</td></tr>
          <tr><td>Energía consumida</td><td class="num">{{ r.delta.kwhA | number: '1.0-0' }} kWh</td><td class="num">{{ r.delta.kwhB | number: '1.0-0' }} kWh</td><td class="num">—</td></tr>
          <tr><td>Coste medio</td><td class="num">{{ r.delta.avgCostPerKwhA != null ? (r.delta.avgCostPerKwhA | number: '1.4-4') + ' €/kWh' : '—' }}</td><td class="num">{{ r.delta.avgCostPerKwhB != null ? (r.delta.avgCostPerKwhB | number: '1.4-4') + ' €/kWh' : '—' }}</td><td class="num" [class.pos]="(r.delta.deltaCostPerKwh ?? 0) > 0" [class.neg]="(r.delta.deltaCostPerKwh ?? 0) < 0">{{ r.delta.deltaCostPerKwh != null ? (r.delta.deltaCostPerKwh | number: '1.4-4') : '—' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card" *ngIf="!result && !loading">
      <p class="muted">Elige el modo de comparación, los suministros/periodos y pulsa <strong>Comparar</strong>.</p>
    </div>
  `,
  styles: [
    `
      .seg { display: flex; width: fit-content; margin: 0 auto 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
      .seg button { background: var(--card); color: var(--text); border: 0; border-radius: 0; padding: 8px 18px; }
      .seg button.on { background: var(--accent); color: #fff; }
      .sides { display: flex; gap: 24px; flex-wrap: wrap; }
      .side { flex: 1; min-width: 240px; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; background: var(--bg); }
      .side h4, .common h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .side label { margin-bottom: 10px; }
      .common { margin-top: 14px; padding: 14px 16px; border: 1px dashed var(--border); border-radius: 10px; background: var(--bg); }
      .common select { max-width: 360px; }
      .common .row2 { max-width: 360px; }
      .row2 { display: flex; gap: 12px; }
      .row2 label { flex: 1; }
      .chk { flex-direction: row; align-items: center; gap: 8px; color: var(--text); }
      .chk input { width: auto; }
      .small { font-size: 0.8rem; }
      .muted { color: var(--muted); }
      .badges { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
      .badge { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px; min-width: 150px; border-left: 4px solid var(--muted); }
      .badge.up { border-left-color: #c62828; }
      .badge.down { border-left-color: #2e7d32; }
      .badge .bv { display: block; font-size: 1.25rem; font-weight: 700; }
      .badge.up .bv { color: #c62828; }
      .badge.down .bv { color: #2e7d32; }
      .badge .bl { display: block; font-size: 0.75rem; color: var(--muted); margin-top: 2px; }
      .chart-wrap { position: relative; height: 300px; margin-bottom: 18px; }
      .ct { margin: 8px 0 10px; font-size: 0.9rem; }
      td.pos { color: #c62828; }
      td.neg { color: #2e7d32; }
      .grand td { font-weight: 700; border-top: 2px solid var(--border); }
      @media (max-width: 720px) { .sides { flex-direction: column; } }
    `,
  ],
})
export class ComparisonComponent {
  supplies = [
    { cups: 'ES0031000000000002JN', label: 'ES0031000000000002JN — Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', label: 'ES0031000000000001JN — Industrial 3.0TD' },
  ];
  months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  years = [2023, 2024, 2025, 2026];

  mode: 'months' | 'cups' = 'cups';
  freeRange = false;

  // Suministros (en modo 'months' B se iguala a A al comparar).
  cupsA = this.supplies[1].cups; // industrial 3.0TD
  cupsB = this.supplies[0].cups; // pyme 2.0TD

  // Periodos por lado: mes/año y rango libre.
  monthA = 1; yearA = 2025; fromA = '2025-01-01'; toA = '2025-01-31';
  monthB = 2; yearB = 2025; fromB = '2025-02-01'; toB = '2025-02-28';

  loading = false;
  error = '';
  result: ComparisonResult | null = null;

  @ViewChild('barChart') barChart?: ElementRef<HTMLCanvasElement>;
  @ViewChild('secondChart') secondChart?: ElementRef<HTMLCanvasElement>;
  private chart1?: Chart;
  private chart2?: Chart;

  constructor(private gql: GraphqlService) {}

  setMode(m: 'months' | 'cups'): void { this.mode = m; }

  tar(t: string): string { return t === 'T_2_0TD' ? '2.0TD' : '3.0TD'; }

  // Accesores de periodo por lado (evitan repetir plantilla).
  month(side: string): number { return side === 'A' ? this.monthA : this.monthB; }
  year(side: string): number { return side === 'A' ? this.yearA : this.yearB; }
  from(side: string): string { return side === 'A' ? this.fromA : this.fromB; }
  to(side: string): string { return side === 'A' ? this.toA : this.toB; }
  setMonth(side: string, v: number): void { if (side === 'A') this.monthA = +v; else this.monthB = +v; }
  setYear(side: string, v: number): void { if (side === 'A') this.yearA = +v; else this.yearB = +v; }
  setFrom(side: string, v: string): void { if (side === 'A') this.fromA = v; else this.fromB = v; }
  setTo(side: string, v: string): void { if (side === 'A') this.toA = v; else this.toB = v; }

  // Construye { periodFrom, periodTo } de un lado según el selector activo.
  private periodOf(side: 'A' | 'B'): { periodFrom: string; periodTo: string } {
    if (this.freeRange) {
      return side === 'A'
        ? { periodFrom: this.fromA, periodTo: this.toA }
        : { periodFrom: this.fromB, periodTo: this.toB };
    }
    const m = side === 'A' ? this.monthA : this.monthB;
    const y = side === 'A' ? this.yearA : this.yearB;
    const last = new Date(y, m, 0).getDate();
    const mm = String(m).padStart(2, '0');
    return { periodFrom: `${y}-${mm}-01`, periodTo: `${y}-${mm}-${String(last).padStart(2, '0')}` };
  }

  async compare(): Promise<void> {
    this.error = '';
    this.loading = true;
    this.result = null;
    try {
      const pa = this.periodOf('A');
      // En modo 'months' B comparte CUPS con A; en 'cups' B comparte periodo con A.
      const a = { cups: this.cupsA, ...pa };
      const b = this.mode === 'months'
        ? { cups: this.cupsA, ...this.periodOf('B') }
        : { cups: this.cupsB, ...pa };

      const data = await this.gql.request<{ calculateComparison: ComparisonResult }>(COMPARE, { i: { a, b } });
      this.result = data.calculateComparison;
      setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private renderCharts(): void {
    const r = this.result;
    if (!r) return;
    this.chart1?.destroy();
    this.chart2?.destroy();

    // Gráfica 1 — importes por concepto.
    const c1 = this.barChart?.nativeElement;
    if (c1) {
      this.chart1 = new Chart(c1, {
        type: 'bar',
        data: {
          labels: ['T. potencia', 'T. energía', 'Exceso', 'Reactiva', 'Alquiler', 'Impuestos', 'TOTAL'],
          datasets: [
            { label: 'A', backgroundColor: ACCENT, data: this.concepts(r.a) },
            { label: 'B', backgroundColor: ACCENT_B, data: this.concepts(r.b) },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: { display: true, text: '€' } } } },
      });
    }

    // Gráfica 2 — P1–P6 (misma tarifa) o €/kWh (tarifas distintas).
    const c2 = this.secondChart?.nativeElement;
    if (c2) {
      const cfg = r.delta.sameTariff
        ? {
            labels: this.energyPeriods(r),
            datasets: [
              { label: 'A', backgroundColor: ACCENT, data: this.energyByPeriod(r.a, this.energyPeriods(r)) },
              { label: 'B', backgroundColor: ACCENT_B, data: this.energyByPeriod(r.b, this.energyPeriods(r)) },
            ],
            yText: '€ energía',
          }
        : {
            labels: ['Coste medio'],
            datasets: [
              { label: 'A', backgroundColor: ACCENT, data: [r.delta.avgCostPerKwhA ?? 0] },
              { label: 'B', backgroundColor: ACCENT_B, data: [r.delta.avgCostPerKwhB ?? 0] },
            ],
            yText: '€/kWh',
          };
      this.chart2 = new Chart(c2, {
        type: 'bar',
        data: { labels: cfg.labels, datasets: cfg.datasets },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: { display: true, text: cfg.yText } } } },
      });
    }
  }

  private concepts(p: PreInvoice): number[] {
    return [p.powerTerm, p.energyTerm, p.excessPower, p.reactiveEnergy ?? 0, p.meterRental, p.ieeAmount + p.vatAmount, p.total];
  }

  // Etiquetas de período presentes en las líneas de energía (P1..Pn), ordenadas.
  private energyPeriods(r: ComparisonResult): string[] {
    const set = new Set<number>();
    for (const p of [r.a, r.b])
      for (const l of p.lines) if (l.unit === 'kWh' && l.period != null) set.add(l.period);
    return [...set].sort((x, y) => x - y).map(n => `P${n}`);
  }

  private energyByPeriod(p: PreInvoice, labels: string[]): number[] {
    return labels.map(lab => {
      const n = +lab.slice(1);
      return p.lines.filter(l => l.unit === 'kWh' && l.period === n).reduce((s, l) => s + l.amount, 0);
    });
  }
}
