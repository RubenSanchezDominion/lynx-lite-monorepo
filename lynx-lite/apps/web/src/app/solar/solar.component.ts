import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface SolarMonth {
  monthKey: string;
  productionKwh: number;
  selfConsumptionKwh: number;
  surplusKwh: number;
}

interface SolarSimulation {
  id: string;
  kwp: number;
  annualProductionKwh: number;
  annualSelfConsumptionKwh: number;
  annualSurplusKwh: number;
  selfConsumptionRatio: number;
  coverageRatio: number;
  annualSavingEur: number;
  paybackYears: number | null;
  months: SolarMonth[];
}

const FIELDS = `id kwp annualProductionKwh annualSelfConsumptionKwh annualSurplusKwh
  selfConsumptionRatio coverageRatio annualSavingEur paybackYears
  months { monthKey productionKwh selfConsumptionKwh surplusKwh }`;
const LIST = `query($s: String!) { solarSimulations(supplyId: $s) { ${FIELDS} } }`;
const SIMULATE = `mutation($i: SimulateSolarInput!) { simulateSolar(input: $i) { ${FIELDS} } }`;

@Component({
  selector: 'app-solar',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Autoconsumo solar (M06)" />

    <div class="card panel">
      <div class="main">
        <label class="field">Suministro
          <select [(ngModel)]="supplyId" name="supply" (ngModelChange)="onSupplyChange()">
            <option *ngFor="let s of supplies" [value]="s.supplyId">{{ s.label }}</option>
          </select>
        </label>

        <div class="grid-inputs">
          <label class="field">Latitud<input type="number" [(ngModel)]="lat" name="lat" step="0.01" /></label>
          <label class="field">Longitud<input type="number" [(ngModel)]="lon" name="lon" step="0.01" /></label>
          <label class="field">Potencia pico (kWp)<input type="number" [(ngModel)]="kwp" name="kwp" step="1" /></label>
          <label class="field">Pérdidas (%)<input type="number" [(ngModel)]="lossPct" name="loss" step="1" /></label>
          <label class="field">Inclinación (°)<input type="number" [(ngModel)]="tilt" name="tilt" step="1" /></label>
          <label class="field">Orientación (°)<input type="number" [(ngModel)]="azimuth" name="azimuth" step="1" /></label>
          <label class="field">Coste (€/kWp)<input type="number" [(ngModel)]="costPerKwp" name="cost" step="50" /></label>
        </div>
        <button (click)="simulate()" [disabled]="loading">{{ loading ? 'Simulando…' : '☀️ Simular' }}</button>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué calcula?</h4>
        <p class="leg-desc">Cruza la producción solar estimada (PVGIS) con tu <strong>curva real</strong> de
          consumo, hora a hora: autoconsumo, excedentes, ahorro y payback.</p>
        <p class="leg-desc muted">Producción mensual repartida con perfil solar. Payback orientativo: depende
          de €/kWp y de la compensación de excedentes (PVPC medio).</p>
      </aside>
    </div>

    <div class="card" *ngIf="sim as s">
      <h3 class="t">Resultado <span class="muted">· {{ s.kwp }} kWp</span></h3>
      <div class="kpis">
        <div class="kpi"><span class="kv">{{ s.annualProductionKwh | number: '1.0-0' }} kWh</span><span class="kl">producción/año</span></div>
        <div class="kpi"><span class="kv">{{ s.selfConsumptionRatio * 100 | number: '1.0-0' }} %</span><span class="kl">autoconsumo</span></div>
        <div class="kpi"><span class="kv">{{ s.coverageRatio * 100 | number: '1.0-0' }} %</span><span class="kl">cobertura</span></div>
        <div class="kpi"><span class="kv">{{ s.annualSavingEur | number: '1.0-0' }} €</span><span class="kl">ahorro/año</span></div>
        <div class="kpi" [class.good]="s.paybackYears"><span class="kv">{{ s.paybackYears != null ? (s.paybackYears | number: '1.1-1') + ' años' : 'no rentable' }}</span><span class="kl">payback</span></div>
      </div>

      <table class="grid">
        <thead><tr><th>Mes</th><th>Producción kWh</th><th>Autoconsumo kWh</th><th>Excedente kWh</th></tr></thead>
        <tbody>
          <tr *ngFor="let m of s.months">
            <td>{{ m.monthKey }}</td>
            <td>{{ m.productionKwh | number: '1.0-0' }}</td>
            <td>{{ m.selfConsumptionKwh | number: '1.0-0' }}</td>
            <td>{{ m.surplusKwh | number: '1.0-0' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">Usa tu curva real de consumo (no un perfil sintético). Cifras orientativas.</p>
    </div>

    <div class="card" *ngIf="!sim && !loading">
      <p class="muted">Introduce la ubicación y la potencia pico para simular el autoconsumo solar.</p>
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
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .aside h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .leg-desc { font-size: 0.82rem; margin: 0 0 10px; }
      .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
      .kpi { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; min-width: 120px; }
      .kpi .kv { display: block; font-size: 1.2rem; font-weight: 700; color: #15539e; }
      .kpi .kl { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }
      .kpi.good .kv { color: #1e8e3e; }
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
export class SolarComponent implements OnInit {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  supplyId = this.supplies[1].supplyId; // 3.0TD trae una simulación sembrada en demo
  lat = 41.65;
  lon = -0.88;
  kwp = 40;
  lossPct = 14;
  tilt = 35;
  azimuth = 0;
  costPerKwp = 1000;

  loading = false;
  error = '';
  sim: SolarSimulation | null = null;

  constructor(private gql: GraphqlService) {}

  ngOnInit(): void {
    void this.loadLatest();
  }

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? '';
  }

  onSupplyChange(): void {
    this.sim = null;
    void this.loadLatest();
  }

  async loadLatest(): Promise<void> {
    this.error = '';
    try {
      const data = await this.gql.request<{ solarSimulations: SolarSimulation[] }>(LIST, { s: this.supplyId });
      this.sim = data.solarSimulations[0] ?? null;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async simulate(): Promise<void> {
    this.error = '';
    this.loading = true;
    try {
      const data = await this.gql.request<{ simulateSolar: SolarSimulation }>(SIMULATE, {
        i: {
          cups: this.cups(),
          lat: this.lat,
          lon: this.lon,
          kwp: this.kwp,
          lossPct: this.lossPct,
          tilt: this.tilt,
          azimuth: this.azimuth,
          costPerKwp: this.costPerKwp,
        },
      });
      this.sim = data.simulateSolar;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
}
