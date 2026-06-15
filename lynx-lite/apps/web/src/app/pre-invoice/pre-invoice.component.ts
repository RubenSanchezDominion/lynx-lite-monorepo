import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { AuthService } from '../services/auth.service';
import { TopbarComponent } from '../shared/topbar.component';

interface Line {
  concept: string;
  period: number | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  sortOrder: number;
}
interface PreInvoice {
  tariff: string;
  powerTerm: number;
  energyTerm: number;
  excessPower: number;
  reactiveEnergy: number | null;
  meterRental: number;
  subtotal: number;
  ieeAmount: number;
  vatAmount: number;
  total: number;
  gapHoursCount: number;
  gapPeriodsJson: string | null;
  lines: Line[];
}

const CALC = `query($i: PreInvoiceInput!) {
  calculatePreInvoice(input: $i) {
    tariff powerTerm energyTerm excessPower reactiveEnergy meterRental
    subtotal ieeAmount vatAmount total gapHoursCount gapPeriodsJson
    lines { concept period quantity unit unitPrice amount sortOrder }
  }
}`;

@Component({
  selector: 'app-pre-invoice',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Pre-factura (M01)" />

    <div class="card">
      <div class="form-row">
        <label>Suministro (CUPS)
          <select [(ngModel)]="cups" name="cups">
            <option *ngFor="let s of supplies" [value]="s.cups">{{ s.label }}</option>
          </select>
        </label>
        <label>Desde
          <input type="date" [(ngModel)]="periodFrom" name="from" />
        </label>
        <label>Hasta
          <input type="date" [(ngModel)]="periodTo" name="to" />
        </label>
        <button (click)="calculate()" [disabled]="loading">{{ loading ? 'Calculando…' : 'Calcular' }}</button>
      </div>
      <p class="error" *ngIf="error">{{ error }}</p>
    </div>

    <div class="card result" *ngIf="result as r">
      <div class="banner" *ngIf="r.gapHoursCount > 0">
        ⚠️ Esta prefactura contiene {{ r.gapHoursCount }} horas con datos estimados o no disponibles.
        El resultado puede diferir de la factura real.
      </div>

      <div class="totals">
        <div><span>Tarifa</span><b>{{ r.tariff === 'T_2_0TD' ? '2.0TD' : '3.0TD' }}</b></div>
        <div><span>Término potencia</span><b>{{ r.powerTerm | number:'1.2-2' }} €</b></div>
        <div><span>Término energía</span><b>{{ r.energyTerm | number:'1.2-2' }} €</b></div>
        <div *ngIf="r.excessPower > 0"><span>Exceso potencia</span><b>{{ r.excessPower | number:'1.2-2' }} €</b></div>
        <div *ngIf="r.reactiveEnergy != null"><span>Energía reactiva</span><b>{{ r.reactiveEnergy | number:'1.2-2' }} €</b></div>
        <div><span>Alquiler contador</span><b>{{ r.meterRental | number:'1.2-2' }} €</b></div>
        <div><span>IEE</span><b>{{ r.ieeAmount | number:'1.2-2' }} €</b></div>
        <div><span>IVA</span><b>{{ r.vatAmount | number:'1.2-2' }} €</b></div>
        <div class="grand"><span>TOTAL</span><b>{{ r.total | number:'1.2-2' }} €</b></div>
      </div>

      <table>
        <thead>
          <tr><th>Concepto</th><th>P</th><th class="num">Cantidad</th><th>Unidad</th><th class="num">€/ud</th><th class="num">Importe</th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let l of r.lines">
            <td>{{ l.concept }}</td>
            <td>{{ l.period ?? '—' }}</td>
            <td class="num">{{ l.quantity | number:'1.2-4' }}</td>
            <td>{{ l.unit }}</td>
            <td class="num">{{ l.unitPrice | number:'1.2-6' }}</td>
            <td class="num">{{ l.amount | number:'1.2-2' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
})
export class PreInvoiceComponent {
  // CUPS sembrados en el modo memoria del API.
  supplies = [
    { cups: 'ES0031000000000002JN', label: 'ES0031000000000002JN — Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', label: 'ES0031000000000001JN — Industrial 3.0TD' },
  ];
  cups = this.supplies[0].cups;
  periodFrom = '2025-01-01';
  periodTo = '2025-01-31';
  loading = false;
  error = '';
  result: PreInvoice | null = null;

  constructor(private gql: GraphqlService, public auth: AuthService) {}

  async calculate(): Promise<void> {
    this.error = '';
    this.loading = true;
    this.result = null;
    try {
      const data = await this.gql.request<{ calculatePreInvoice: PreInvoice }>(CALC, {
        i: { cups: this.cups, periodFrom: this.periodFrom, periodTo: this.periodTo },
      });
      this.result = data.calculatePreInvoice;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
}
