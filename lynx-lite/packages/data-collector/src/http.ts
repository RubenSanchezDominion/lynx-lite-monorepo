import { DatadisRateLimitError, type DatadisHttp } from './datadis.js';
import type { EsiosHttp } from './esios.js';

function buildQuery(query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ─── Cliente DATADIS con login Bearer + detección de 429 ───────────────────────

export interface DatadisConfig {
  baseUrl: string; // ej. http://localhost:3001
  nif: string;
  password: string;
}

export function createDatadisHttp(config: DatadisConfig): DatadisHttp {
  let token: string | null = null;

  async function login(): Promise<string> {
    const body = new URLSearchParams({ username: config.nif, password: config.password });
    const res = await fetch(`${config.baseUrl}/nikola-auth/tokens/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`DATADIS login falló: ${res.status}`);
    return (await res.text()).trim();
  }

  return {
    async get(path: string, query: Record<string, string>): Promise<unknown> {
      if (!token) token = await login();

      const url = `${config.baseUrl}${path}${buildQuery(query)}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

      if (res.status === 429) throw new DatadisRateLimitError(); // sin reintento (SPECS §1.5)
      if (res.status === 401) {
        // token expirado: reintenta login una vez
        token = await login();
        const retry = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (retry.status === 429) throw new DatadisRateLimitError();
        if (!retry.ok) throw new Error(`DATADIS ${path} → ${retry.status}`);
        return retry.json();
      }
      if (!res.ok) throw new Error(`DATADIS ${path} → ${res.status}`);
      return res.json();
    },
  };
}

// ─── Cliente ESIOS con x-api-key ───────────────────────────────────────────────

export interface EsiosConfig {
  baseUrl: string;
  apiKey: string;
}

export function createEsiosHttp(config: EsiosConfig): EsiosHttp {
  return {
    async get(path: string, query: Record<string, string>): Promise<unknown> {
      const url = `${config.baseUrl}${path}${buildQuery(query)}`;
      const res = await fetch(url, { headers: { 'x-api-key': config.apiKey } });
      if (!res.ok) throw new Error(`ESIOS ${path} → ${res.status}`);
      return res.json();
    },
  };
}
