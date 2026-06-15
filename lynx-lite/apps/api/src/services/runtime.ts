import type { PreInvoiceDataSource } from './preInvoiceData.js';
import type { PowerOptimizationDataSource } from './powerOptimizationData.js';
import type { EnsureData } from './ingestion.js';

// Holder del DataSource de pre-factura. El bootstrap (src/index.ts) lo inicializa
// con la implementación InfluxDB real; los tests lo sustituyen por un mock.
let dataSource: PreInvoiceDataSource | null = null;

export function setDataSource(ds: PreInvoiceDataSource): void {
  dataSource = ds;
}

export function getDataSource(): PreInvoiceDataSource {
  if (!dataSource) {
    throw new Error('PreInvoiceDataSource no inicializado. Llama a setDataSource() en el arranque.');
  }
  return dataSource;
}

// Holder del DataSource de optimización de potencia (M02). Mismo patrón: el bootstrap lo
// inicializa con la implementación InfluxDB; los tests lo sustituyen por un mock.
let optimizationDataSource: PowerOptimizationDataSource | null = null;

export function setOptimizationDataSource(ds: PowerOptimizationDataSource): void {
  optimizationDataSource = ds;
}

export function getOptimizationDataSource(): PowerOptimizationDataSource {
  if (!optimizationDataSource) {
    throw new Error(
      'PowerOptimizationDataSource no inicializado. Llama a setOptimizationDataSource() en el arranque.',
    );
  }
  return optimizationDataSource;
}

// Holder de la ingesta on-demand (opcional). Si no se inicializa, el servicio de
// pre-factura asume que el worker ya tiene los datos (backfillStatus DONE).
let ensureData: EnsureData | undefined;

export function setIngestion(fn: EnsureData): void {
  ensureData = fn;
}

export function getIngestion(): EnsureData | undefined {
  return ensureData;
}
