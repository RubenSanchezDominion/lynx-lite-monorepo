// Calendario tarifario simplificado — réplica de lynx-lite-mocks/services/datadis/generators.js
// (getPeriod, líneas 74-93). La asignación se hace en HORA LOCAL DE ESPAÑA (Europe/Madrid),
// no en UTC: DATADIS devuelve hora local; ESIOS devuelve UTC y hay que convertir.

export type Tariff = 'T_2_0TD' | 'T_3_0TD';

// Extrae (hora, díaSemana) en zona Europe/Madrid a partir de un instante UTC.
// díaSemana: 0=domingo … 6=sábado (igual que Date.getDay()).
const madridFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  weekday: 'short',
  hour: '2-digit',
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function madridHourAndDay(utc: Date): { hour: number; day: number } {
  const parts = madridFormatter.formatToParts(utc);
  let hour = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = parseInt(part.value, 10) % 24;
    if (part.type === 'weekday') day = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return { hour, day };
}

// Asigna P1–P6 dado el día de la semana, la hora local y la tarifa.
// Idéntico al mock getPeriod(date, hour, tariff).
export function getPeriod(day: number, hour: number, tariff: Tariff): string {
  const isWeekend = day === 0 || day === 6;

  if (tariff === 'T_2_0TD') {
    if (isWeekend) return 'P3';
    if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'P1';
    if ((hour >= 8 && hour < 10) || (hour >= 14 && hour < 18) || (hour >= 22 && hour < 24)) return 'P2';
    return 'P3'; // madrugada
  }

  // 3.0TD (y 6.XTD fuera de alcance) — simplificación peninsular invierno
  if (isWeekend) return 'P6';
  if (hour >= 10 && hour < 14) return 'P1';
  if ((hour >= 8 && hour < 10) || (hour >= 18 && hour < 22)) return 'P2';
  if ((hour >= 14 && hour < 18) || (hour >= 22 && hour < 24)) return 'P3';
  if (hour >= 6 && hour < 8) return 'P4';
  if (hour >= 1 && hour < 6) return 'P5';
  return 'P6'; // hora 0
}

// Período para un instante UTC dado (convierte a hora Madrid primero).
export function periodForUtc(utc: Date, tariff: Tariff): string {
  const { hour, day } = madridHourAndDay(utc);
  return getPeriod(day, hour, tariff);
}

// Parsea fecha+hora LOCAL de DATADIS ('YYYY/MM/DD', 'HH:MM') a un instante UTC.
// Interpreta los componentes como hora de pared en Europe/Madrid.
export function parseDatadisLocal(date: string, time: string): {
  utc: Date;
  hour: number;
  day: number;
} {
  const [y, m, d] = date.split('/').map(Number);
  const [hh, mm] = time.split(':').map(Number);

  // Construimos el instante como si fuera UTC y corregimos por el offset de Madrid.
  const asUtc = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const offsetMin = madridOffsetMinutes(asUtc);
  const utc = new Date(asUtc.getTime() - offsetMin * 60_000);

  // Día de la semana y hora locales (los componentes dados ya son locales).
  const localDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { utc, hour: hh, day: localDow };
}

// Offset de Europe/Madrid en minutos para un instante dado (+60 CET, +120 CEST).
function madridOffsetMinutes(utc: Date): number {
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    timeZoneName: 'shortOffset',
  });
  const parts = tzFormatter.formatToParts(utc);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const match = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 60;
  const hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + Math.sign(hours) * mins;
}
