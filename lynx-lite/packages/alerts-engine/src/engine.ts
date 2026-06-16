import type {
  AlertDetectionInput,
  AlertInterval,
  DetectedAlert,
  InactivityWindow,
  SensitivityName,
} from './types.js';

const HOUR_MS = 3_600_000;

// Sensibilidad → umbral de |z| (SPECS §5.0 punto 2 / §5.4 Paso 1).
const Z_THRESHOLD: Record<SensitivityName, number> = {
  CONSERVADOR: 3.5,
  EQUILIBRADO: 3.0,
  AGRESIVO: 2.5,
};

// Mínimo de muestras de referencia para una desviación típica muestral con sentido.
const MIN_REFERENCE_SAMPLES = 2;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Desviación típica MUESTRAL (n−1). Devuelve 0 si hay menos de 2 muestras.
export function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function slotKey(weekday: number, hour: number): string {
  return `${weekday}-${hour}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ¿La hora local del intervalo cae dentro de la franja? Soporta cruce de medianoche (from > to).
function inInactivityWindow(weekday: number, hour: number, w: InactivityWindow): boolean {
  if (!w.days.includes(weekday)) return false;
  const min = hour * 60;
  const from = toMinutes(w.from);
  const to = toMinutes(w.to);
  if (from <= to) return min >= from && min < to;
  return min >= from || min < to; // [from, 24:00) ∪ [00:00, to)
}

function windowEnd(ts: string, intervalHours: number): string {
  return new Date(new Date(ts).getTime() + intervalHours * HOUR_MS).toISOString();
}

// Detección pura: devuelve las alertas candidatas del día. La persistencia y la idempotencia
// (no revivir alertas ya gestionadas) las hace el servicio/job (SPECS §5.4 Paso 5).
export function detectAlerts(input: AlertDetectionInput): DetectedAlert[] {
  const { config, intervalHours } = input;
  const enabled = new Set(config.enabledTypes);
  const zThreshold = Z_THRESHOLD[config.sensitivity];
  const out: DetectedAlert[] = [];

  for (const iv of input.targetDay) {
    const wEnd = windowEnd(iv.ts, intervalHours);

    // Paso 4 — ESTIMATED (calidad de dato). Opera sobre intervalos estimados (gap=true).
    if (enabled.has('ESTIMATED') && iv.estimated) {
      out.push({
        type: 'ESTIMATED',
        severity: 'INFO',
        period: iv.period,
        windowStart: iv.ts,
        windowEnd: wEnd,
        observedValue: iv.kwh,
        expectedValue: null,
        deviation: null,
        message: `Dato estimado por la distribuidora (no medido) a las ${iv.localHour}:00.`,
      });
    }

    // Los detectores de consumo solo operan sobre datos facturables (gap=false).
    if (iv.gap) continue;

    // Paso 1 — ZSCORE (anomalía estadística por slot semanal-horario).
    if (enabled.has('ZSCORE')) {
      const ref = input.referenceBySlot[slotKey(iv.weekday, iv.localHour)] ?? [];
      if (ref.length >= MIN_REFERENCE_SAMPLES) {
        const mu = mean(ref);
        const sd = sampleStd(ref);
        if (sd > 0) {
          const z = (iv.kwh - mu) / sd;
          if (Math.abs(z) >= zThreshold) {
            const severity = Math.abs(z) >= zThreshold + 1.5 ? 'CRITICAL' : 'WARNING';
            const dir = z > 0 ? 'anómalamente alto' : 'anómalamente bajo';
            out.push({
              type: 'ZSCORE',
              severity,
              period: iv.period,
              windowStart: iv.ts,
              windowEnd: wEnd,
              observedValue: iv.kwh,
              expectedValue: mu,
              deviation: z,
              message: `Consumo ${dir} a las ${iv.localHour}:00 (z=${z.toFixed(2)}).`,
            });
          }
        }
      }
    }

    // Paso 2 — PHANTOM (consumo en franja declarada inactiva).
    if (enabled.has('PHANTOM')) {
      const inactive = config.inactivityWindows.some(w =>
        inInactivityWindow(iv.weekday, iv.localHour, w),
      );
      if (inactive && iv.kwh > config.phantomThresholdKwh) {
        out.push({
          type: 'PHANTOM',
          severity: 'WARNING',
          period: iv.period,
          windowStart: iv.ts,
          windowEnd: wEnd,
          observedValue: iv.kwh,
          expectedValue: config.phantomThresholdKwh,
          deviation: iv.kwh - config.phantomThresholdKwh,
          message: `Consumo en franja declarada inactiva a las ${iv.localHour}:00 (${iv.kwh.toFixed(2)} kWh).`,
        });
      }
    }

    // Paso 3 — LIMIT (proximidad a la potencia contratada).
    if (enabled.has('LIMIT')) {
      const pc = input.contractedPower[`P${iv.period}`];
      if (pc !== undefined && pc > 0) {
        const kw = iv.kwh / intervalHours;
        if (kw >= config.limitThresholdPct * pc) {
          const severity = kw >= pc ? 'CRITICAL' : 'WARNING';
          out.push({
            type: 'LIMIT',
            severity,
            period: iv.period,
            windowStart: iv.ts,
            windowEnd: wEnd,
            observedValue: kw,
            expectedValue: pc,
            deviation: kw / pc,
            message: `Potencia ${kw.toFixed(2)} kW cerca del límite contratado ${pc} kW a las ${iv.localHour}:00.`,
          });
        }
      }
    }
  }

  return out;
}

export type { AlertInterval };
