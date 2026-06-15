import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface OptPeriod {
  period: number;
  currentPower: number;
  optimalPower: number;
  p99Power: number;
  observedMax: number;
  diagnosis: 'OK' | 'OVERSIZED' | 'UNDERSIZED';
  marginPct: number;
}
interface PowerOptimization {
  tariff: string;
  analysisFrom: string;
  analysisTo: string;
  granularity: string;
  upliftFactor: number;
  sampleCount: number;
  fixedSaving: number;
  excessSaving: number;
  annualSaving: number;
  recommendChange: boolean;
  changeAllowed: boolean;
  changeBlockedUntil: string | null;
  periods: OptPeriod[];
}

const CALC = `query($i: PowerOptimizationInput!) {
  calculatePowerOptimization(input: $i) {
    tariff analysisFrom analysisTo granularity upliftFactor sampleCount
    fixedSaving excessSaving annualSaving recommendChange changeAllowed changeBlockedUntil
    periods { period currentPower optimalPower p99Power observedMax diagnosis marginPct }
  }
}`;

@Component({
  selector: 'app-optimization',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Optimización de potencia (M02)" />

    <div class="card">
      <div class="form-row">
        <label>Suministro (CUPS)
          <select [(ngModel)]="cups" name="cups">
            <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
          </select>
        </label>
        <label>Desde
          <input type="date" [(ngModel)]="analysisFrom" name="from" />
        </label>
        <label>Hasta
          <input type="date" [(ngModel)]="analysisTo" name="to" />
        </label>
        <button (click)="calculate()" [disabled]="loading">{{ loading ? 'Analizando…' : 'Analizar' }}</button>
      </div>
      <p class="hint">Requiere al menos 12 meses de curva de carga.</p>
      <p class="error" *ngIf="error">{{ error }}</p>
    </div>

    <div class="card result" *ngIf="result as r">
      <!-- VEREDICTO: la decisión, de un vistazo -->
      <div class="verdict" [ngClass]="verdictClass(r)">
        <div class="v-icon">{{ verdictIcon(r) }}</div>
        <div class="v-body">
          <div class="v-title">{{ verdictTitle(r) }}</div>
          <div class="v-sub" *ngIf="r.recommendChange">
            Ahorro anual estimado <b>≈ {{ r.annualSaving | number:'1.0-0' }} €/año</b>
          </div>
          <div class="v-sub" *ngIf="!r.recommendChange">
            No se estima ahorro al cambiar la potencia con tu distribuidora actual.
          </div>
        </div>
      </div>

      <!-- ACCIÓN: qué potencia solicitar y cuándo -->
      <div class="action" *ngIf="r.recommendChange">
        <h3>Potencia a solicitar por período</h3>
        <div class="pchips">
          <span class="pchip" *ngFor="let p of r.periods" [ngClass]="p.diagnosis.toLowerCase()">
            <span class="pp">P{{ p.period }}</span>
            <b>{{ p.optimalPower | number:'1.0-1' }} kW</b>
            <small>antes {{ p.currentPower | number:'1.0-0' }}</small>
          </span>
        </div>
        <p class="constraint" [class.blocked]="!r.changeAllowed">
          {{ r.changeAllowed
              ? '✓ Puedes solicitar el cambio ahora.'
              : '⚠️ La distribuidora solo permite un cambio al año: no podrás volver a cambiar hasta ' + r.changeBlockedUntil + '.' }}
        </p>
      </div>

      <!-- Desglose neto compacto -->
      <p class="breakdown">
        <span>Tarifa <b>{{ r.tariff === 'T_2_0TD' ? '2.0TD' : '3.0TD' }}</b></span>
        ·
        <span>Término fijo
          <b [class.pos]="r.fixedSaving > 0" [class.neg]="r.fixedSaving < 0">{{ r.fixedSaving | number:'1.0-0' }} €</b>
        </span>
        ·
        <span>{{ r.excessSaving < 0 ? 'Penaliz. excesos' : 'Excesos evitados' }}
          <b [class.pos]="r.excessSaving > 0" [class.neg]="r.excessSaving < 0">{{ r.excessSaving | number:'1.0-0' }} €</b>
        </span>
        <span class="hint"> · análisis {{ r.analysisFrom }} → {{ r.analysisTo }} ({{ r.granularity }} ×{{ r.upliftFactor }})</span>
      </p>

      <table>
        <thead>
          <tr>
            <th>Período</th>
            <th class="num">Contratada (kW)</th>
            <th class="num">Óptima (kW)</th>
            <th class="num">p99 (kW)</th>
            <th class="num">Máx. observado (kW)</th>
            <th class="num">Margen</th>
            <th>Diagnóstico</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let p of r.periods">
            <td>P{{ p.period }}</td>
            <td class="num">{{ p.currentPower | number:'1.0-3' }}</td>
            <td class="num">{{ p.optimalPower | number:'1.0-3' }}</td>
            <td class="num">{{ p.p99Power | number:'1.0-3' }}</td>
            <td class="num">{{ p.observedMax | number:'1.0-3' }}</td>
            <td class="num">{{ p.marginPct | number:'1.1-1' }} %</td>
            <td>
              <span class="diag" [ngClass]="p.diagnosis.toLowerCase()">{{ diagLabel(p.diagnosis) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
  styles: [
    `
      /* Veredicto */
      .verdict { display: flex; gap: 14px; align-items: center; padding: 18px 20px; border-radius: 10px; margin-bottom: 18px; }
      .verdict .v-icon { font-size: 1.8rem; line-height: 1; }
      .verdict .v-title { font-size: 1.15rem; font-weight: 700; }
      .verdict .v-sub { font-size: 0.95rem; margin-top: 2px; }
      .verdict .v-sub b { font-size: 1.05rem; }
      .verdict.opportunity { background: #e6f4ea; color: #1e5631; }
      .verdict.good { background: #eef3f8; color: #2a4a63; }
      .verdict.risk { background: #fdecea; color: #8a2018; }

      /* Acción */
      .action h3 { font-size: 0.95rem; margin: 0 0 8px; color: var(--text); }
      .pchips { display: flex; flex-wrap: wrap; gap: 8px; }
      .pchip { display: flex; flex-direction: column; align-items: center; min-width: 84px; padding: 8px 12px;
               border-radius: 8px; background: var(--bg); border: 1px solid var(--border); }
      .pchip .pp { font-size: 0.72rem; color: var(--muted); }
      .pchip b { font-size: 1rem; }
      .pchip small { font-size: 0.68rem; color: var(--muted); }
      .pchip.oversized { border-color: #bcdcf5; }
      .pchip.undersized { border-color: #f5c6c0; background: #fdf2f1; }
      .constraint { margin: 12px 0 0; font-size: 0.9rem; color: #1e7e34; }
      .constraint.blocked { color: #b25c00; }

      .breakdown { margin: 18px 0 4px; font-size: 0.85rem; color: var(--muted); }
      .breakdown b { color: var(--text); }
      .breakdown b.pos { color: #1e7e34; }
      .breakdown b.neg { color: #c62828; }
      .breakdown .hint { color: var(--muted); }

      .diag { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
      .diag.ok { background: #e6f4ea; color: #1e7e34; }
      .diag.oversized { background: #e3f0fb; color: #1565c0; }
      .diag.undersized { background: #fdecea; color: #c62828; }
    `,
  ],
})
export class OptimizationComponent {
  // CUPS sembrados en el modo memoria del API.
  supplies = [
    { cups: 'ES0031000000000002JN', label: 'ES0031000000000002JN — Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', label: 'ES0031000000000001JN — Industrial 3.0TD' },
  ];
  cups = this.supplies[1].cups; // por defecto el 3.0TD (caso más rico)
  analysisFrom = '2024-01-01';
  analysisTo = '2024-12-31';
  loading = false;
  error = '';
  result: PowerOptimization | null = null;

  constructor(private gql: GraphqlService) {}

  private hasUndersized(r: PowerOptimization): boolean {
    return r.periods.some(p => p.diagnosis === 'UNDERSIZED');
  }

  // Veredicto = la decisión que el usuario busca: ¿toco la potencia o no?
  verdictClass(r: PowerOptimization): string {
    if (r.recommendChange) return 'opportunity';
    return this.hasUndersized(r) ? 'risk' : 'good';
  }

  verdictIcon(r: PowerOptimization): string {
    if (r.recommendChange) return '💡';
    return this.hasUndersized(r) ? '⚠️' : '✓';
  }

  verdictTitle(r: PowerOptimization): string {
    const under = this.hasUndersized(r);
    const over = r.periods.some(p => p.diagnosis === 'OVERSIZED');
    if (r.recommendChange) {
      if (under && over) return 'Conviene reajustar la potencia contratada';
      if (under) return 'Conviene subir la potencia: hay riesgo de penalización por excesos';
      return 'Conviene reducir la potencia contratada';
    }
    if (under) return 'Potencia insuficiente en algún período (riesgo de penalización)';
    return 'Tu potencia está bien dimensionada: no es necesario cambiar';
  }

  async calculate(): Promise<void> {
    this.error = '';
    this.loading = true;
    this.result = null;
    try {
      const data = await this.gql.request<{ calculatePowerOptimization: PowerOptimization }>(CALC, {
        i: { cups: this.cups, analysisFrom: this.analysisFrom, analysisTo: this.analysisTo },
      });
      this.result = data.calculatePowerOptimization;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  diagLabel(d: string): string {
    return d === 'OVERSIZED' ? 'Sobredimensionado' : d === 'UNDERSIZED' ? 'Infradimensionado' : 'Correcto';
  }
}
