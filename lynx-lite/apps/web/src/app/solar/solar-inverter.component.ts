import { Component, Input, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from '../services/graphql.service';

// M06.3 — asistente de importación de producción FV real (ingesta de inversor). El navegador solo lee
// las primeras filas para previsualizar y proponer; la normalización dura la hace el backend (§8.12.0).

interface Mapping {
  timeColumn: string;
  timeFormat?: string | null;
  valueColumns: string[];
  valueKind: string;
  unitScaleToKwh: number;
  decimal: string;
  timezone: string;
  skipRows: number;
}
interface Proposal { mapping: Mapping; confidence: number; presetMatched?: string | null; warnings: string[]; }
interface UploadResult {
  report: {
    rowsParsed: number; rowsSkipped: number; rangeStart: string; rangeEnd: string;
    detectedUnit: string; detectedTimezone: string; hourGaps: number; duplicates: number;
    negativeDropped: number; coveragePct: number; consumptionOverlapPct: number; warnings: string[];
  };
  realSolar: {
    annualProductionKwh: number; annualSelfConsumptionKwh: number; annualSurplusKwh: number;
    selfConsumptionRatio: number; coverageRatio: number; annualSavingEur: number; paybackYears: number | null;
    months: { monthKey: string; productionKwh: number; selfConsumptionKwh: number; surplusKwh: number }[];
  };
  performance: {
    measuredKwh: number; expectedKwh: number; performanceRatio: number; specificYieldKwhPerKwp: number;
    months: { key: string; measuredKwh: number; expectedKwh: number; ratio: number }[];
    underperforming: boolean; underperformancePct: number;
  };
}

const DETECT = `query($i: DetectInverterMappingInput!) {
  detectInverterMapping(input: $i) {
    mapping { timeColumn timeFormat valueColumns valueKind unitScaleToKwh decimal timezone skipRows }
    confidence presetMatched warnings
  }
}`;
const ANALYZE = `mutation($i: AnalyzeInverterUploadInput!) {
  analyzeInverterUpload(input: $i) {
    report { rowsParsed rowsSkipped rangeStart rangeEnd detectedUnit detectedTimezone hourGaps duplicates negativeDropped coveragePct consumptionOverlapPct warnings }
    realSolar { annualProductionKwh annualSelfConsumptionKwh annualSurplusKwh selfConsumptionRatio coverageRatio annualSavingEur paybackYears months { monthKey productionKwh selfConsumptionKwh surplusKwh } }
    performance { measuredKwh expectedKwh performanceRatio specificYieldKwhPerKwp underperforming underperformancePct months { key measuredKwh expectedKwh ratio } }
  }
}`;

const VALUE_KINDS = [
  { v: 'ENERGY_INTERVAL', l: 'Energía por intervalo (kWh)' },
  { v: 'POWER', l: 'Potencia instantánea (kW)' },
  { v: 'CUMULATIVE_TOTAL', l: 'Contador acumulado total' },
  { v: 'CUMULATIVE_DAILY', l: 'Contador acumulado diario' },
];

@Component({
  selector: 'app-solar-inverter',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="card panel">
      <div class="main">
        <p class="leg-desc">Sube el fichero de <strong>generación</strong> que exporta tu inversor (Huawei,
          Fronius, SolarEdge, Enphase, Victron, Solis… o cualquier marca), en <strong>CSV o Excel</strong>.
          Detectamos las columnas y tú confirmas el mapeo: cruzamos la producción <strong>real medida</strong>
          con tu consumo real.</p>

        <div class="grid-inputs">
          <label class="field">Suministro
            <select [(ngModel)]="supplyId" name="supply">
              <option *ngFor="let s of supplies" [value]="s.supplyId">{{ s.label }}</option>
            </select>
          </label>
          <label class="field">Latitud<input type="number" [(ngModel)]="lat" name="lat" step="0.01" /></label>
          <label class="field">Longitud<input type="number" [(ngModel)]="lon" name="lon" step="0.01" /></label>
        </div>

        <label class="field">Fichero del inversor (CSV o Excel)
          <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" (change)="onFile($event)" />
        </label>
        <label class="field" *ngIf="sheetNames.length > 1">Hoja del Excel
          <select [(ngModel)]="selectedSheet" name="sheet" (ngModelChange)="onSheetChange()">
            <option *ngFor="let s of sheetNames" [value]="s">{{ s }}</option>
          </select>
        </label>
        <p class="error" *ngIf="error">{{ error }}</p>
      </div>

      <aside class="aside">
        <h4>¿Qué hace?</h4>
        <p class="leg-desc">Con tu producción <strong>medida</strong> calcula el autoconsumo, los excedentes
          y el ahorro <strong>reales</strong>, y compara lo producido con lo esperable (PVGIS) para detectar
          <strong>infraproducción</strong> (suciedad, sombras, string caído).</p>
        <p class="leg-desc muted">Fase 1: el análisis se hace al vuelo, sin guardar la serie.</p>
      </aside>
    </div>

    <!-- Paso 2: confirmar el mapeo propuesto -->
    <div class="card" *ngIf="proposal as p">
      <h3 class="t">Confirma el mapeo
        <span class="muted">· confianza {{ p.confidence * 100 | number: '1.0-0' }}%</span>
        <span class="badge" *ngIf="p.presetMatched">{{ p.presetMatched }}</span>
      </h3>
      <p class="warn" *ngFor="let w of p.warnings">⚠️ {{ w }}</p>

      <div class="grid-inputs">
        <label class="field">Columna de tiempo
          <select [(ngModel)]="mapping.timeColumn" name="tcol">
            <option *ngFor="let h of headers" [value]="h">{{ h }}</option>
          </select>
        </label>
        <label class="field">Formato de fecha<input [(ngModel)]="mapping.timeFormat" name="tfmt" /></label>
        <label class="field">Tipo de valor
          <select [(ngModel)]="mapping.valueKind" name="vkind">
            <option *ngFor="let k of valueKinds" [value]="k.v">{{ k.l }}</option>
          </select>
        </label>
        <label class="field">Escala a kWh<input type="number" [(ngModel)]="mapping.unitScaleToKwh" name="scale" step="0.001" /></label>
        <label class="field">Decimal
          <select [(ngModel)]="mapping.decimal" name="dec"><option value=".">punto (.)</option><option value=",">coma (,)</option></select>
        </label>
        <label class="field">Huso horario<input [(ngModel)]="mapping.timezone" name="tz" /></label>
        <label class="field">Filas a saltar<input type="number" [(ngModel)]="mapping.skipRows" name="skip" step="1" /></label>
      </div>

      <label class="field">Columnas de energía (una por inversor; Ctrl/Cmd para varias)
        <select multiple [(ngModel)]="mapping.valueColumns" name="vcols" size="4">
          <option *ngFor="let h of headers" [value]="h">{{ h }}</option>
        </select>
      </label>

      <h4 class="sub">Vista previa</h4>
      <div class="preview"><table class="grid">
        <tr *ngFor="let row of previewRows"><td *ngFor="let cell of row">{{ cell }}</td></tr>
      </table></div>

      <label class="field">Potencia instalada de la planta (kWp)
        <input #kwpInput type="number" [(ngModel)]="kwp" name="kwp" step="1" placeholder="obligatorio"
          [class.invalid]="kwpError" (ngModelChange)="kwpError = ''" />
        <small class="hint" *ngIf="kwpFromFile && !kwpError">Detectado del fichero · confírmalo</small>
        <small class="field-error" *ngIf="kwpError">{{ kwpError }}</small>
      </label>

      <button (click)="analyze()" [disabled]="loading">{{ loading ? 'Analizando…' : '📈 Analizar producción real' }}</button>
    </div>

    <!-- Paso 3: resultados -->
    <div class="card" *ngIf="result as r">
      <h3 class="t">Producción real medida</h3>
      <div class="kpis">
        <div class="kpi"><span class="kv">{{ r.realSolar.annualProductionKwh | number: '1.0-0' }} kWh</span><span class="kl">producción medida</span></div>
        <div class="kpi"><span class="kv">{{ r.realSolar.selfConsumptionRatio * 100 | number: '1.0-0' }} %</span><span class="kl">autoconsumo</span></div>
        <div class="kpi"><span class="kv">{{ r.realSolar.coverageRatio * 100 | number: '1.0-0' }} %</span><span class="kl">cobertura</span></div>
        <div class="kpi good"><span class="kv">{{ r.realSolar.annualSavingEur | number: '1.0-0' }} €</span><span class="kl">ahorro real</span></div>
      </div>

      <h4 class="sub">Rendimiento vs esperado (PVGIS)</h4>
      <div class="kpis">
        <div class="kpi" [class.bad]="r.performance.underperforming"><span class="kv">{{ r.performance.performanceRatio * 100 | number: '1.0-0' }} %</span><span class="kl">performance ratio</span></div>
        <div class="kpi"><span class="kv">{{ r.performance.specificYieldKwhPerKwp | number: '1.0-0' }}</span><span class="kl">kWh/kWp</span></div>
        <div class="kpi" *ngIf="r.performance.underperforming"><span class="kv">−{{ r.performance.underperformancePct | number: '1.0-0' }} %</span><span class="kl">bajo lo esperado</span></div>
      </div>
      <p class="warn alarm" *ngIf="prWarning">⚠️ {{ prWarning }}</p>
      <ng-container *ngIf="!prWarning">
        <p class="warn" *ngIf="r.performance.underperforming">⚠️ La planta produce por debajo de lo esperable: revisa suciedad, sombras o un string caído.</p>
        <p class="ok" *ngIf="!r.performance.underperforming">✅ La producción está dentro de lo esperable para esta planta.</p>
      </ng-container>

      <h4 class="sub">Validación del fichero</h4>
      <p class="muted">{{ r.report.rowsParsed }} filas · cobertura {{ r.report.coveragePct | number: '1.0-0' }}% ·
        solape con consumo {{ r.report.consumptionOverlapPct | number: '1.0-0' }}% · unidad {{ r.report.detectedUnit }} ·
        huso {{ r.report.detectedTimezone }}</p>
      <p class="warn" *ngFor="let w of r.report.warnings">⚠️ {{ w }}</p>

      <table class="grid">
        <thead><tr><th>Mes</th><th>Medido kWh</th><th>Esperado kWh</th><th>Ratio</th></tr></thead>
        <tbody>
          <tr *ngFor="let m of r.performance.months">
            <td>{{ m.key }}</td>
            <td>{{ m.measuredKwh | number: '1.0-0' }}</td>
            <td>{{ m.expectedKwh | number: '1.0-0' }}</td>
            <td [class.bad]="m.ratio < 0.85">{{ m.ratio * 100 | number: '1.0-0' }} %</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">Cifras orientativas: el baseline PVGIS es de un año meteorológico tipo, no del periodo real.</p>
    </div>
  `,
  styles: [
    `
      .t { margin: 0 0 12px; font-size: 1rem; }
      .sub, .aside h4 { margin: 18px 0 10px; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
      .muted { color: var(--muted); font-weight: 400; }
      .panel { display: flex; gap: 24px; align-items: flex-start; }
      .main { flex: 1; min-width: 0; }
      .field { margin-bottom: 12px; display: block; font-size: 0.85rem; color: var(--muted); }
      .field input, .field select { display: block; margin-top: 4px; }
      .grid-inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px 16px; margin-bottom: 12px; }
      input:not([type=file]), select { max-width: 220px; }
      .aside { width: 250px; flex: 0 0 250px; border-left: 1px solid var(--border); padding-left: 20px; }
      .leg-desc { font-size: 0.82rem; margin: 0 0 10px; }
      .badge { font-size: 0.7rem; background: var(--accent); color: #fff; border-radius: 6px; padding: 2px 8px; margin-left: 8px; }
      .preview { overflow-x: auto; margin-bottom: 14px; }
      .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 8px; }
      .kpi { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; min-width: 120px; }
      .kpi .kv { display: block; font-size: 1.2rem; font-weight: 700; color: #15539e; }
      .kpi .kl { display: block; font-size: 0.76rem; color: var(--muted); margin-top: 2px; }
      .kpi.good .kv { color: #1e8e3e; }
      .kpi.bad .kv { color: #c0392b; }
      table.grid { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
      .grid th, .grid td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
      .grid th { font-size: 0.76rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
      td.bad { color: #c0392b; font-weight: 600; }
      .error { color: #c0392b; }
      .warn { color: #b7791f; font-size: 0.85rem; margin: 4px 0; }
      .warn.alarm { background: #fff4e5; border: 1px solid #f0c36d; border-radius: 8px; padding: 10px 12px; font-weight: 500; }
      .ok { color: #1e8e3e; font-size: 0.85rem; margin: 4px 0; }
      .hint, .field-error { display: block; margin-top: 3px; font-size: 0.72rem; }
      .hint { color: #1e8e3e; }
      .field-error { color: #c0392b; font-weight: 500; }
      input.invalid { border: 1px solid #c0392b !important; }
      @media (max-width: 720px) { .panel { flex-direction: column; } .aside { width: auto; flex: none; border-left: 0; border-top: 1px solid var(--border); padding: 16px 0 0; } }
    `,
  ],
})
export class SolarInverterComponent {
  @Input() supplies: { cups: string; supplyId: string; label: string }[] = [];
  supplyId = '';
  lat = 41.65;
  lon = -0.88;
  kwp: number | null = null; // sin default: se rellena del fichero si se detecta, o lo teclea el usuario
  kwpFromFile = false; // true si se autodetectó de los metadatos del fichero (para avisar en UI)

  valueKinds = VALUE_KINDS;
  rawRows: string[][] = [];
  headers: string[] = [];
  previewRows: string[][] = [];
  // Excel multi-hoja: si el libro trae varias, el usuario elige cuál contiene la generación.
  private workbook: import('xlsx').WorkBook | null = null;
  private xlsxSync: typeof import('xlsx') | null = null; // instancia ya importada (para helpers síncronos)
  sheetNames: string[] = [];
  selectedSheet = '';
  proposal: Proposal | null = null;
  mapping: Mapping = { timeColumn: '', valueColumns: [], valueKind: 'ENERGY_INTERVAL', unitScaleToKwh: 1, decimal: '.', timezone: 'Europe/Madrid', skipRows: 0 };
  result: UploadResult | null = null;
  loading = false;
  error = '';
  kwpError = ''; // error específico del campo kWp (se muestra bajo el input, no al final)

  @ViewChild('kwpInput') kwpInput?: ElementRef<HTMLInputElement>;

  constructor(private gql: GraphqlService) {}

  private cups(): string {
    return this.supplies.find(s => s.supplyId === this.supplyId)?.cups ?? this.supplies[0]?.cups ?? '';
  }

  // Parser CSV mínimo en el navegador: solo para previsualizar y proponer (el backend re-parsea en serio).
  private parseCsv(text: string): string[][] {
    const clean = text.replace(/^﻿/, '');
    const lines = clean.split(/\r\n|\n|\r/).filter(l => l.length > 0);
    if (lines.length === 0) return [];
    const score = (d: string) => lines.slice(0, 10).reduce((a, l) => a + (l.split(d).length - 1), 0);
    const delim = score(';') > score(',') ? ';' : ',';
    return lines.map(l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, '')));
  }

  // Carga el libro Excel (SheetJS, import dinámico → chunk lazy ya presente por M04). No normaliza:
  // el backend re-parsea los strings con el mapeo confirmado. Igual criterio que kpi.component.ts.
  // Preselecciona la hoja con MÁS pinta de tabla de datos (no la primera ciega: los portales suelen
  // poner una portada/resumen delante). El selector deja corregir.
  private async loadWorkbook(file: File): Promise<void> {
    const XLSX = await import('xlsx');
    this.xlsxSync = XLSX;
    this.workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    this.sheetNames = this.workbook.SheetNames;
    this.selectedSheet = this.pickBestSheet();
  }

  // Filas (string[][]) de una hoja del libro (la seleccionada por defecto).
  private async sheetToRows(): Promise<string[][]> {
    if (!this.workbook || !this.selectedSheet) return [];
    return this.rowsOfSheet(this.selectedSheet);
  }

  private rowsOfSheet(name: string): string[][] {
    const XLSX = this.xlsxSync!;
    const ws = this.workbook!.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false });
    return rows.map(r => r.map(c => (c == null ? '' : String(c))));
  }

  // Elige la hoja que más parece tabla de datos de inversor: la que tiene más filas con una celda
  // que parece fecha/hora Y al menos una celda numérica. Empate o sin señal → la primera.
  private pickBestSheet(): string {
    const looksTime = (c: string) => /\d{4}-\d{2}-\d{2}/.test(c) || /\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(c) || /\d{10,13}/.test(c.trim());
    const looksNum = (c: string) => /^[\s]*[-+]?\d[\d.,\s]*$/.test(c) && /\d/.test(c);
    let best = this.sheetNames[0] ?? '';
    let bestScore = -1;
    for (const name of this.sheetNames) {
      const rows = this.rowsOfSheet(name);
      let score = 0;
      for (const row of rows.slice(0, 60)) {
        const hasTime = row.some(looksTime);
        const hasNum = row.some(looksNum);
        if (hasTime && hasNum) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }

  async onFile(ev: Event): Promise<void> {
    this.error = '';
    this.kwpError = '';
    this.result = null;
    this.workbook = null;
    this.xlsxSync = null;
    this.sheetNames = [];
    this.selectedSheet = '';
    this.kwpFromFile = false;
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const isExcel = /\.(xlsx|xls)$/i.test(file.name);
      if (isExcel) {
        await this.loadWorkbook(file);
        this.rawRows = await this.sheetToRows();
      } else {
        this.rawRows = this.parseCsv(await file.text());
      }
      await this.refreshFromRows();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  // Cambio de hoja (Excel multi-hoja): recomputa las filas y re-detecta el mapeo.
  async onSheetChange(): Promise<void> {
    this.error = '';
    this.result = null;
    try {
      this.rawRows = await this.sheetToRows();
      await this.refreshFromRows();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  // Preview + auto-detección de mapeo a partir de rawRows. Común a CSV y a (re)elegir hoja Excel.
  private async refreshFromRows(): Promise<void> {
    this.previewRows = this.rawRows.slice(0, 8);
    if (this.supplyId === '' && this.supplies[0]) this.supplyId = this.supplies[0].supplyId;
    const data = await this.gql.request<{ detectInverterMapping: Proposal }>(DETECT, {
      i: { cups: this.cups(), sampleRows: this.rawRows.slice(0, 40) },
    });
    this.proposal = data.detectInverterMapping;
    this.mapping = { ...data.detectInverterMapping.mapping };
    // Cabecera para los selectores (la fila skipRows del fichero crudo).
    this.headers = this.rawRows[this.mapping.skipRows] ?? this.rawRows[0] ?? [];
    // Intentar autodetectar la potencia instalada de los metadatos del fichero (si no la tecleó ya).
    this.tryDetectKwp();
  }

  // Busca "capacidad/potencia instalada … <número> kWp" en las primeras filas crudas (metadatos del
  // portal). Si la encuentra y el usuario no había puesto un kWp, la propone. Un kWp incoherente con la
  // planta es la causa nº1 de un performance ratio absurdo (p. ej. 60 kWp medido vs baseline a 40).
  private tryDetectKwp(): void {
    if (this.kwp != null) return; // respeta lo que el usuario haya tecleado
    for (const row of this.rawRows.slice(0, 10)) {
      const joined = row.join(' ').toLowerCase();
      if (/(capacidad|potencia)\s*instalada|kwp|kw pico/.test(joined)) {
        // Busca un número en la fila (admite coma decimal). Toma el primero plausible (> 0).
        for (const cell of row) {
          const n = Number(cell.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
          if (Number.isFinite(n) && n > 0) {
            this.kwp = n;
            this.kwpFromFile = true;
            return;
          }
        }
      }
    }
  }

  // Aviso si el performance ratio sale fuera de rango realista: casi siempre significa que el kWp o la
  // ubicación no coinciden con la planta (baseline mal calibrado), NO que la planta sea genial/penosa.
  get prWarning(): string | null {
    const pr = this.result?.performance.performanceRatio;
    if (pr == null) return null;
    if (pr > 1.2) return `Rendimiento del ${(pr * 100).toFixed(0)}%: parece demasiado alto. Revisa que el kWp (${this.kwp ?? '—'}) y la ubicación coincidan con la planta — probablemente el baseline esperado no está bien calibrado.`;
    if (pr < 0.4) return `Rendimiento del ${(pr * 100).toFixed(0)}%: parece demasiado bajo. Antes de asumir una avería, revisa que el kWp y la ubicación sean correctos.`;
    return null;
  }

  async analyze(): Promise<void> {
    this.error = '';
    this.kwpError = '';
    if (this.kwp == null || !(this.kwp > 0)) {
      this.kwpError = 'Indica la potencia instalada de la planta para poder analizar.';
      // Lleva el ojo (y el foco) al campo culpable, esté donde esté en la página.
      this.kwpInput?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.kwpInput?.nativeElement.focus();
      return;
    }
    this.loading = true;
    try {
      const { timeFormat, ...rest } = this.mapping;
      const data = await this.gql.request<{ analyzeInverterUpload: UploadResult }>(ANALYZE, {
        i: {
          cups: this.cups(),
          rows: this.rawRows,
          mapping: { ...rest, timeFormat: timeFormat || null },
          kwp: this.kwp,
          lat: this.lat,
          lon: this.lon,
        },
      });
      this.result = data.analyzeInverterUpload;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }
}
