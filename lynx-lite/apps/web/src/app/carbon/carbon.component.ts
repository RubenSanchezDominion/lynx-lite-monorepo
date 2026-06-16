import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface CarbonLine {
  monthKey: string;
  monthStart: string;
  kwh: number;
  co2Kg: number;
  factorAvg: number;
  hasGaps: boolean;
}

interface CarbonReport {
  id: string;
  rangeStart: string;
  rangeEnd: string;
  totalKwh: number;
  totalCo2Kg: number;
  ownFactorGPerKwh: number;
  nationalAvgFactor: number;
  deltaPct: number;
  hasGaps: boolean;
  lines: CarbonLine[];
}

const RPT_FIELDS = `id rangeStart rangeEnd totalKwh totalCo2Kg ownFactorGPerKwh nationalAvgFactor deltaPct hasGaps
  lines { monthKey monthStart kwh co2Kg factorAvg hasGaps }`;
const LIST = `query($s: String!) { carbonReports(supplyId: $s) { ${RPT_FIELDS} } }`;
const COMPUTE = `mutation($i: ComputeCarbonInput!) { computeCarbonFootprint(input: $i) { ${RPT_FIELDS} } }`;

@Component({
  selector: 'app-carbon',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Huella de carbono (M05)" />

    <div class="card panel">
      <div class="main">
        <label class="field">Suministro
          <select [(ngModel)]="supplyId" name="supply" (ngModelChange)="onSupplyChange()">
            <option *ngFor="let s of supplies" [value]="s.supplyId">{{ s.label }}</option>
          </select>
        </label>

        <div class="range">
          <label class="field">Desde
            <input type="date" [(ngModel)]="from" name="from" />
          </label>
          <label class="field">Hasta
            <input type="date" [(ngModel)]="to" name="to" />
          </label>
          <button (click)="compute()" [disabled]="loading">{{ loading ? 'Calculando…' : '🌱 Calcular huella' }}</button>
        </div>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué calcula?</h4>
        <p class="leg-desc">Las <strong>emisiones de CO₂</strong> de tu consumo, hora a hora, usando el
          <strong>factor de emisión</strong> del mix eléctrico (REData). Compara tu factor con la
          <strong>media nacional</strong> del periodo.</p>
        <p class="leg-desc muted">Material para reporting <strong>CSRD</strong>. Los coeficientes por tecnología
          son valores de partida, pendientes de calibrar con fuente oficial.</p>
      </aside>
    </div>

    <div class="card" *ngIf="report as r">
      <h3 class="t">Emisiones <span class="muted">· {{ r.rangeStart | slice: 0:10 }} → {{ r.rangeEnd | slice: 0:10 }}</span></h3>
      <div class="banner" *ngIf="r.hasGaps">⚠️ Algunos tramos usan consumo estimado o con huecos; la huella puede ser aproximada.</div>

      <div class="kpis">
        <div class="kpi"><span class="kv">{{ r.totalCo2Kg | number: '1.0-0' }} kg</span><span class="kl">CO₂eq total</span></div>
        <div class="kpi"><span class="kv">{{ r.totalKwh | number: '1.0-0' }} kWh</span><span class="kl">consumo</span></div>
        <div class="kpi"><span class="kv">{{ r.ownFactorGPerKwh | number: '1.0-0' }}</span><span class="kl">tu factor (gCO₂/kWh)</span></div>
        <div class="kpi"><span class="kv">{{ r.nationalAvgFactor | number: '1.0-0' }}</span><span class="kl">media nacional</span></div>
        <div class="kpi" [class.good]="r.deltaPct < 0" [class.bad]="r.deltaPct > 0">
          <span class="kv">{{ r.deltaPct > 0 ? '+' : '' }}{{ r.deltaPct * 100 | number: '1.1-1' }} %</span>
          <span class="kl">vs media nacional</span>
        </div>
      </div>

      <table class="grid">
        <thead><tr><th>Mes</th><th>kWh</th><th>kgCO₂</th><th>Factor (gCO₂/kWh)</th></tr></thead>
        <tbody>
          <tr *ngFor="let l of r.lines">
            <td>{{ l.monthKey }}</td>
            <td>{{ l.kwh | number: '1.0-0' }}</td>
            <td>{{ l.co2Kg | number: '1.0-1' }}</td>
            <td>{{ l.factorAvg | number: '1.0-0' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">Factor propio = media ponderada por consumo · media nacional = media temporal del periodo.</p>
    </div>

    <div class="card" *ngIf="!report && !loading">
      <p class="muted">Selecciona un suministro y un rango de fechas para calcular la huella de carbono.</p>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 12px; font-size: 1rem; }
      .muted { color: var(--muted); font-weight: 400; }
      .panel { display: flex; gap: 24px; align-items: flex-start; }
      .main { flex: 1; min-width: 0; }
      .field { margin-bottom: 16px; display: block; }
      .range { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
      select, input[type=date] { max-width: 240px; }
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .aside h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .leg-desc { font-size: 0.82rem; margin: 0 0 10px; }
      .banner { background: #fef6dd; color: #5a4500; border: 1px solid #f4d77a; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.88rem; }
      .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
      .kpi { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; min-width: 130px; }
      .kpi .kv { display: block; font-size: 1.2rem; font-weight: 700; color: #15539e; }
      .kpi .kl { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }
      .kpi.good .kv { color: #1e8e3e; }
      .kpi.bad .kv { color: #c0392b; }
      table.grid { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
      .grid th, .grid td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
      .grid th { font-size: 0.76rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
      .error { color: #c0392b; }
      @media (max-width: 720px) {
        .panel { flex-direction: column; }
        .aside { width: auto; flex: none; border-left: 0; border-top: 1px solid var(--border); padding: 16px 0 0; }
      }
    `,
  ],
})
export class CarbonComponent implements OnInit {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  supplyId = this.supplies[1].supplyId; // 3.0TD trae un informe sembrado en demo
  from = '2026-03-01';
  to = '2026-06-01';

  loading = false;
  error = '';
  report: CarbonReport | null = null;

  constructor(private gql: GraphqlService) {}

  ngOnInit(): void {
    void this.loadLatest();
  }

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? '';
  }

  onSupplyChange(): void {
    this.report = null;
    void this.loadLatest();
  }

  // Carga el último informe del suministro (sembrado en demo).
  async loadLatest(): Promise<void> {
    this.error = '';
    try {
      const data = await this.gql.request<{ carbonReports: CarbonReport[] }>(LIST, { s: this.supplyId });
      this.report = data.carbonReports[0] ?? null;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async compute(): Promise<void> {
    this.error = '';
    this.loading = true;
    try {
      const data = await this.gql.request<{ computeCarbonFootprint: CarbonReport }>(COMPUTE, {
        i: { cups: this.cups(), from: `${this.from}T00:00:00.000Z`, to: `${this.to}T00:00:00.000Z` },
      });
      this.report = data.computeCarbonFootprint;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
}
