import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';
import { TopbarComponent } from '../shared/topbar.component';

interface ParsedRow {
  startTs: string;
  endTs: string;
  units: number;
  shift?: string;
  line?: string;
  batch?: string;
}

interface KpiLine {
  bucketKey: string;
  bucketStart: string;
  units: number;
  kwh: number;
  costEur: number;
  eurPerUnit: number;
  isOutlier: boolean;
}

interface KpiReport {
  id: string;
  granularity: string;
  avgEurPerUnit: number;
  totalUnits: number;
  totalKwh: number;
  totalCostEur: number;
  baselineEurPerUnit: number;
  hasGaps: boolean;
  lines: KpiLine[];
}

const UPLOADS = `query($s: String!) { productionUploads(supplyId: $s) { id fileName rowCount uploadedAt } }`;
const SUBMIT = `mutation($i: SubmitProductionInput!) { submitProductionData(input: $i) { id rowCount } }`;
const RPT_FIELDS = `id granularity avgEurPerUnit totalUnits totalKwh totalCostEur baselineEurPerUnit hasGaps
  lines { bucketKey bucketStart units kwh costEur eurPerUnit isOutlier }`;
const COMPUTE = `mutation($i: ComputeKpiInput!) { computeKpi(input: $i) { ${RPT_FIELDS} } }`;

// Normaliza un encabezado: minúsculas, sin acentos, sin espacios laterales.
const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

@Component({
  selector: 'app-kpi',
  standalone: true,
  imports: [CommonModule, FormsModule, TopbarComponent],
  template: `
    <app-topbar section="Coste por unidad producida (M04)" />

    <!-- Card 1: suministro + fichero + granularidad -->
    <div class="card panel">
      <div class="main">
        <label class="field">Suministro
          <select [(ngModel)]="supplyId" name="supply" (ngModelChange)="onSupplyChange()">
            <option *ngFor="let s of supplies" [value]="s.supplyId">{{ s.label }}</option>
          </select>
        </label>

        <label class="field">Agrupar por
          <select [(ngModel)]="granularity" name="gran" (ngModelChange)="recompute()">
            <option value="SHIFT">Turno</option>
            <option value="DAY">Día</option>
            <option value="WEEK">Semana</option>
            <option value="MONTH">Mes</option>
          </select>
        </label>

        <div class="field">
          <span class="lbl">Subir producción (CSV o Excel)</span>
          <input type="file" accept=".csv,.xlsx" (change)="onFile($event)" />
          <span class="hint">Columnas: timestamp_inicio, timestamp_fin, unidades_producidas (opcional: turno, linea, lote).</span>
        </div>

        <div class="actions" *ngIf="preview.length">
          <span class="muted">{{ preview.length }} filas leídas del fichero.</span>
          <button (click)="submitAndCompute()" [disabled]="loading">{{ loading ? 'Procesando…' : '⬆️ Subir y calcular' }}</button>
        </div>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué calcula?</h4>
        <p class="leg-desc">El <strong>coste de la energía</strong> consumida (PVPC + peajes y cargos) repartido sobre las
          <strong>unidades producidas</strong> de cada tramo. Resalta los periodos con <strong>€/unidad atípico</strong> (±20 %).</p>
        <p class="leg-desc muted">Con un único punto de suministro el coste no se separa por línea si hay producción en paralelo.</p>
      </aside>
    </div>

    <!-- Previsualización del fichero antes de enviar -->
    <div class="card" *ngIf="preview.length">
      <h3 class="t">Previsualización <span class="muted">({{ preview.length }})</span></h3>
      <table class="grid">
        <thead><tr><th>Inicio</th><th>Fin</th><th>Unidades</th><th>Turno</th><th>Línea</th><th>Lote</th></tr></thead>
        <tbody>
          <tr *ngFor="let r of preview.slice(0, 12)">
            <td>{{ r.startTs }}</td><td>{{ r.endTs }}</td><td>{{ r.units }}</td>
            <td>{{ r.shift || '—' }}</td><td>{{ r.line || '—' }}</td><td>{{ r.batch || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" *ngIf="preview.length > 12">… y {{ preview.length - 12 }} más.</p>
    </div>

    <!-- Resultado -->
    <div class="card" *ngIf="report as r">
      <h3 class="t">Coste por unidad <span class="muted">· {{ granLabel(r.granularity) }}</span></h3>
      <div class="banner" *ngIf="r.hasGaps">⚠️ Algunos tramos usan consumo estimado o con huecos; el coste puede ser aproximado.</div>

      <div class="kpis">
        <div class="kpi"><span class="kv">{{ r.avgEurPerUnit | number: '1.4-4' }} €</span><span class="kl">€/unidad medio</span></div>
        <div class="kpi"><span class="kv">{{ r.totalUnits | number: '1.0-0' }}</span><span class="kl">unidades</span></div>
        <div class="kpi"><span class="kv">{{ r.totalKwh | number: '1.0-1' }} kWh</span><span class="kl">energía</span></div>
        <div class="kpi"><span class="kv">{{ r.totalCostEur | number: '1.2-2' }} €</span><span class="kl">coste energía</span></div>
      </div>

      <table class="grid">
        <thead><tr><th>Periodo</th><th>Unidades</th><th>kWh</th><th>Coste €</th><th>€/unidad</th></tr></thead>
        <tbody>
          <tr *ngFor="let l of r.lines" [class.outlier]="l.isOutlier">
            <td>{{ l.bucketKey }}</td>
            <td>{{ l.units | number: '1.0-0' }}</td>
            <td>{{ l.kwh | number: '1.0-1' }}</td>
            <td>{{ l.costEur | number: '1.2-2' }}</td>
            <td><strong>{{ l.eurPerUnit | number: '1.4-4' }}</strong><span class="flag" *ngIf="l.isOutlier"> atípico</span></td>
          </tr>
        </tbody>
      </table>
      <p class="muted">Baseline (mediana) {{ r.baselineEurPerUnit | number: '1.4-4' }} €/ud · atípico si se desvía más de ±20 %.</p>
    </div>

    <div class="card" *ngIf="!report && !preview.length && !loading">
      <p class="muted">Sube un fichero de producción para calcular el coste por unidad, o selecciona un suministro con datos sembrados.</p>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 12px; font-size: 1rem; }
      .muted { color: var(--muted); font-weight: 400; }
      .panel { display: flex; gap: 24px; align-items: flex-start; }
      .main { flex: 1; min-width: 0; }
      .field { margin-bottom: 16px; display: block; }
      .field .lbl { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 8px; }
      select, input[type=file] { max-width: 360px; }
      .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .hint { display: block; font-size: 0.78rem; color: var(--muted); margin-top: 6px; }
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .aside h4 { margin: 0 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .leg-desc { font-size: 0.82rem; margin: 0 0 10px; }
      .banner { background: #fef6dd; color: #5a4500; border: 1px solid #f4d77a; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.88rem; }
      .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
      .kpi { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; min-width: 130px; }
      .kpi .kv { display: block; font-size: 1.2rem; font-weight: 700; color: #15539e; }
      .kpi .kl { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }
      table.grid { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
      .grid th, .grid td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
      .grid th { font-size: 0.76rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
      .grid tr.outlier { background: #fff6e6; }
      .grid tr.outlier td { color: #8a5a00; }
      .flag { font-size: 0.72rem; font-weight: 700; color: #e0a100; margin-left: 6px; }
      .error { color: #c0392b; }
      @media (max-width: 720px) {
        .panel { flex-direction: column; }
        .aside { width: auto; flex: none; border-left: 0; border-top: 1px solid var(--border); padding: 16px 0 0; }
      }
    `,
  ],
})
export class KpiComponent implements OnInit {
  supplies = [
    { cups: 'ES0031000000000002JN', supplyId: 'supply-20td', label: 'Pyme 2.0TD' },
    { cups: 'ES0031000000000001JN', supplyId: 'supply-30td', label: 'Industrial 3.0TD' },
  ];
  supplyId = this.supplies[1].supplyId; // 3.0TD trae producción sembrada en demo
  granularity = 'DAY';

  loading = false;
  error = '';
  fileName = '';
  preview: ParsedRow[] = [];
  uploadId: string | null = null;
  report: KpiReport | null = null;

  constructor(private gql: GraphqlService) {}

  ngOnInit(): void {
    void this.loadLatest();
  }

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? '';
  }

  onSupplyChange(): void {
    this.report = null;
    this.preview = [];
    this.uploadId = null;
    void this.loadLatest();
  }

  // Carga el último upload del suministro y calcula su KPI (datos sembrados en demo).
  async loadLatest(): Promise<void> {
    this.error = '';
    try {
      const data = await this.gql.request<{ productionUploads: { id: string }[] }>(UPLOADS, { s: this.supplyId });
      const latest = data.productionUploads[0];
      if (!latest) {
        this.report = null;
        return;
      }
      this.uploadId = latest.id;
      await this.recompute();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async recompute(): Promise<void> {
    if (!this.uploadId) return;
    this.error = '';
    this.loading = true;
    try {
      const data = await this.gql.request<{ computeKpi: KpiReport }>(COMPUTE, {
        i: { uploadId: this.uploadId, granularity: this.granularity },
      });
      this.report = data.computeKpi;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error = '';
    this.fileName = file.name;
    try {
      const matrix = file.name.toLowerCase().endsWith('.xlsx')
        ? await this.readXlsx(file)
        : this.readCsv(await file.text());
      this.preview = this.mapMatrix(matrix);
      if (!this.preview.length) this.error = 'No se han encontrado filas válidas en el fichero.';
    } catch (e) {
      this.error = 'No se ha podido leer el fichero: ' + (e as Error).message;
    }
  }

  async submitAndCompute(): Promise<void> {
    if (!this.preview.length) return;
    this.error = '';
    this.loading = true;
    try {
      const res = await this.gql.request<{ submitProductionData: { id: string } }>(SUBMIT, {
        i: {
          cups: this.cups(),
          fileName: this.fileName || 'produccion',
          format: this.fileName.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV',
          rows: this.preview.map(r => ({
            startTs: r.startTs,
            endTs: r.endTs,
            units: r.units,
            shift: r.shift || null,
            line: r.line || null,
            batch: r.batch || null,
          })),
        },
      });
      this.uploadId = res.submitProductionData.id;
      this.preview = [];
      await this.recompute();
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  // ─── Parseo en cliente ────────────────────────────────────────────────────
  private readCsv(text: string): string[][] {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
    return lines.map(l => l.split(sep));
  }

  private async readXlsx(file: File): Promise<string[][]> {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false });
    return rows.map(r => r.map(c => (c == null ? '' : String(c))));
  }

  private mapMatrix(matrix: string[][]): ParsedRow[] {
    if (matrix.length < 2) return [];
    const header = matrix[0].map(norm);
    const col = (names: string[]) => header.findIndex(h => names.includes(h));
    const iStart = col(['timestamp_inicio', 'inicio', 'start']);
    const iEnd = col(['timestamp_fin', 'fin', 'end']);
    const iUnits = col(['unidades_producidas', 'unidades', 'units']);
    const iShift = col(['turno', 'shift']);
    const iLine = col(['linea', 'line']);
    const iBatch = col(['lote', 'batch']);
    if (iStart < 0 || iEnd < 0 || iUnits < 0) return [];

    const get = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const out: ParsedRow[] = [];
    for (const row of matrix.slice(1)) {
      const startTs = get(row, iStart);
      const endTs = get(row, iEnd);
      const units = Number(get(row, iUnits).replace(',', '.'));
      if (!startTs || !endTs || !(units > 0)) continue;
      out.push({
        startTs,
        endTs,
        units,
        shift: get(row, iShift) || undefined,
        line: get(row, iLine) || undefined,
        batch: get(row, iBatch) || undefined,
      });
    }
    return out;
  }

  granLabel(g: string): string {
    return ({ SHIFT: 'por turno', DAY: 'por día', WEEK: 'por semana', MONTH: 'por mes' } as Record<string, string>)[g] ?? g;
  }
}
