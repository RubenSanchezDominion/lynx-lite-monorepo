import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TopbarComponent } from '../shared/topbar.component';

interface ReportRow {
  name: string;
  type: string;
  period: string;
  supply: string;
  generatedAt: string;
  sizeKb: number;
  format: string;
}

// DEMO — Tabla de informes generados mensualmente. Datos hardcodeados, sin backend.
@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Informes" />

    <div class="card">
      <span class="demo-badge">DEMO · datos de ejemplo</span>
      <p class="muted intro">Histórico de informes generados automáticamente cada mes. Esta pantalla es una maqueta: los botones de descarga no hacen nada.</p>
      <label class="filter">Filtrar por tipo
        <select [(ngModel)]="filter" name="filter">
          <option value="">Todos</option>
          <option *ngFor="let t of types" [value]="t">{{ t }}</option>
        </select>
      </label>
    </div>

    <div class="card">
      <h3 class="t">Informes generados <span class="muted">({{ visible().length }})</span></h3>
      <table>
        <thead>
          <tr><th>Nombre del informe</th><th>Tipo</th><th>Periodo</th><th>Suministro</th><th>Generado</th><th>Formato</th><th>Tamaño</th><th></th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let r of visible()">
            <td class="name"><span class="fic">📄</span>{{ r.name }}</td>
            <td><span class="pill">{{ r.type }}</span></td>
            <td>{{ r.period }}</td>
            <td>{{ r.supply }}</td>
            <td>{{ r.generatedAt }}</td>
            <td class="mono">{{ r.format }}</td>
            <td>{{ r.sizeKb | number: '1.0-0' }} KB</td>
            <td><button class="dl" (click)="noop()">⬇️ Descargar</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 14px; font-size: 1rem; }
      .muted { color: var(--muted); }
      .intro { margin: 8px 0 14px; font-size: 0.9rem; }
      .demo-badge {
        display: inline-block; background: #fef6dd; color: #8a6d00; border: 1px solid #f4d77a;
        border-radius: 999px; padding: 3px 12px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.3px;
      }
      .filter { max-width: 260px; }
      .mono { font-family: ui-monospace, monospace; font-size: 0.82rem; }
      table { width: 100%; border-collapse: collapse; }
      .name { font-weight: 600; }
      .fic { margin-right: 8px; }
      .pill { font-size: 0.74rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: #eef3fb; color: #15539e; }
      .dl {
        background: rgba(47, 128, 237, 0.12); color: #15539e; border: 0; border-radius: 6px;
        padding: 5px 10px; font-size: 0.82rem; cursor: pointer; white-space: nowrap;
      }
      .dl:hover { background: rgba(47, 128, 237, 0.22); }
    `,
  ],
})
export class ReportsComponent {
  filter = '';
  types = ['Pre-factura', 'Optimización', 'Huella CO₂', 'KPI producción', 'Comparativa'];

  reports: ReportRow[] = [
    { name: 'Pre-factura · Aceros del Norte · Mayo 2026', type: 'Pre-factura', period: 'Mayo 2026', supply: 'ES0031…0001JN', generatedAt: '01/06/2026 06:03', sizeKb: 184, format: 'PDF' },
    { name: 'Pre-factura · Panadería Centro · Mayo 2026', type: 'Pre-factura', period: 'Mayo 2026', supply: 'ES0031…0002JN', generatedAt: '01/06/2026 06:03', sizeKb: 142, format: 'PDF' },
    { name: 'Optimización de potencia · Aceros del Norte · Q2 2026', type: 'Optimización', period: 'Abr–Jun 2026', supply: 'ES0031…0001JN', generatedAt: '01/06/2026 06:10', sizeKb: 96, format: 'PDF' },
    { name: 'Huella de carbono · Aceros del Norte · Mayo 2026', type: 'Huella CO₂', period: 'Mayo 2026', supply: 'ES0031…0001JN', generatedAt: '02/06/2026 06:05', sizeKb: 210, format: 'PDF' },
    { name: 'KPI €/unidad producida · Aceros del Norte · Mayo 2026', type: 'KPI producción', period: 'Mayo 2026', supply: 'ES0031…0001JN', generatedAt: '02/06/2026 06:12', sizeKb: 320, format: 'XLSX' },
    { name: 'Comparativa 2.0TD vs 3.0TD · Panadería Centro · Mayo 2026', type: 'Comparativa', period: 'Mayo 2026', supply: 'ES0031…0002JN', generatedAt: '03/06/2026 09:41', sizeKb: 88, format: 'PDF' },
    { name: 'Pre-factura · Aceros del Norte · Abril 2026', type: 'Pre-factura', period: 'Abril 2026', supply: 'ES0031…0001JN', generatedAt: '01/05/2026 06:02', sizeKb: 179, format: 'PDF' },
    { name: 'Huella de carbono · Panadería Centro · Abril 2026', type: 'Huella CO₂', period: 'Abril 2026', supply: 'ES0031…0002JN', generatedAt: '02/05/2026 06:04', sizeKb: 156, format: 'PDF' },
    { name: 'KPI €/unidad producida · Aceros del Norte · Abril 2026', type: 'KPI producción', period: 'Abril 2026', supply: 'ES0031…0001JN', generatedAt: '02/05/2026 06:11', sizeKb: 305, format: 'XLSX' },
  ];

  visible(): ReportRow[] {
    return this.filter ? this.reports.filter(r => r.type === this.filter) : this.reports;
  }

  noop(): void {
    // DEMO: la descarga no hace nada.
  }
}
