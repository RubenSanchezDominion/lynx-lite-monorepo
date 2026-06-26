// Parseo de tiempo → epoch UTC (ms), con conversión de huso local + DST. Puro y determinista.
// Sin librerías externas (alineado con el resto de packages): el desfase del huso se calcula con
// `Intl.DateTimeFormat`, el mismo mecanismo que `madridMonthHour` en solarService.

// Componentes de pared (sin huso) de un timestamp.
interface Wall {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Desfase (en ms) del huso `tz` para el instante UTC `utcMs`: cuánto hay que sumar al UTC para obtener
// la hora de pared local. Resuelve DST porque pregunta a Intl por ESE instante concreto.
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - utcMs;
}

// Convierte una hora de PARED en el huso `tz` a epoch UTC (ms). El offset depende del propio instante
// (DST), así que se itera dos veces: estimación con el offset del UTC ingenuo y corrección. Dos pasadas
// bastan salvo en el instante exacto del salto (ambigüedad documentada como limitación).
export function wallToUtcMs(w: Wall, tz: string): number {
  const naiveUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = naiveUtc - tzOffsetMs(naiveUtc, tz);
  guess = naiveUtc - tzOffsetMs(guess, tz);
  return guess;
}

// Parsea un string de tiempo a epoch UTC (ms) según el `format` y el `tz`. Devuelve null si no parsea.
// Formatos soportados: "ISO" (Date.parse, respeta offset propio; el tz solo aplica si el ISO es naive),
// "EPOCH_S"/"EPOCH_MS" (numérico, ya UTC), o un patrón con tokens YYYY MM DD HH mm ss (hora local en tz).
export function parseTimeToUtcMs(raw: string, format: string | undefined, tz: string): number | null {
  const s = raw.trim();
  if (s === '') return null;

  if (format === 'EPOCH_S') {
    const n = Number(s);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  if (format === 'EPOCH_MS') {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (format === 'ISO' || format === undefined) {
    // Si el ISO trae offset/Z, Date.parse lo respeta. Si es naive ("2026-06-01T10:00:00"), se interpreta
    // como hora local del huso → reparseamos sus componentes y aplicamos tz.
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
    if (hasZone) {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : null;
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return wallToUtcMs(
        { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 },
        tz,
      );
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }

  // Patrón explícito con separadores arbitrarios. Detecta el orden de los componentes de fecha.
  const wall = parsePatterned(s, format, tz);
  return wall;
}

// Extrae los números de un string y los asigna según el ORDEN de tokens del patrón. Robusto a
// separadores (/ - . : espacio). Soporta day-first (DD/MM) y month-first (MM/DD) según el patrón.
function parsePatterned(s: string, format: string, tz: string): number | null {
  const nums = s.match(/\d+/g);
  if (!nums) return null;
  const tokens = format.match(/YYYY|YY|MM|DD|HH|mm|ss/g);
  if (!tokens) return null;

  const v: Record<string, number> = {};
  for (let i = 0; i < tokens.length && i < nums.length; i++) {
    let n = Number(nums[i]);
    if (tokens[i] === 'YY') n += n < 70 ? 2000 : 1900;
    v[tokens[i]] = n;
  }
  const year = v.YYYY ?? v.YY;
  const month = v.MM;
  const day = v.DD;
  if (year === undefined || month === undefined || day === undefined) return null;
  return wallToUtcMs(
    { year, month, day, hour: v.HH ?? 0, minute: v.mm ?? 0, second: v.ss ?? 0 },
    tz,
  );
}

// Hora UTC en punto (ms) que contiene a `ms`: trunca minutos/segundos/ms.
export function floorToHourUtc(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

// Clave "YYYY-MM" del mes LOCAL (en `tz`) de un instante UTC. Para los buckets mensuales del performance.
export function monthKeyLocal(utcMs: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return `${p.year}-${p.month}`;
}

// Día LOCAL ("YYYY-MM-DD" en `tz`) de un instante UTC. Para detectar el reset de los acumulados diarios.
export function dayKeyLocal(utcMs: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}
