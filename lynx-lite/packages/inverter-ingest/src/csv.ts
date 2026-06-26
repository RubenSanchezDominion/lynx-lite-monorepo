// Parser CSV mínimo y tolerante para la subida del inversor. Detecta el delimitador (`,` o `;`) por la
// fila con más columnas, respeta comillas dobles. No interpreta tipos: devuelve matriz de strings cruda
// (la interpretación la hace applyMapping con el mapeo confirmado). Puro.
export function parseCsv(text: string, delimiter?: string): string[][] {
  const clean = text.replace(/^﻿/, ''); // quita BOM si lo hay
  const lines = clean.split(/\r\n|\n|\r/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const delim = delimiter ?? sniffDelimiter(lines);
  return lines.map(line => splitLine(line, delim));
}

function sniffDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 10);
  const score = (d: string) => sample.reduce((acc, l) => acc + (l.split(d).length - 1), 0);
  return score(';') > score(',') ? ';' : ',';
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}
