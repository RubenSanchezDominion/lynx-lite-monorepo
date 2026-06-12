import { describe, it, expect, vi } from 'vitest';
import type { WriteApi, QueryApi } from '@influxdata/influxdb-client';
import type { DatadisHttp, EsiosHttp } from '@lynx-lite/data-collector';
import { makeOnDemandIngestion } from '../../src/services/ingestion.js';

function mockWriteApi() {
  return { writePoint: vi.fn(), flush: vi.fn() } as unknown as WriteApi & { writePoint: ReturnType<typeof vi.fn> };
}
// queryApi cuyo collectRows devuelve lo indicado (por defecto []).
function mockQueryApi(rows: unknown[] = []) {
  const collectRows = vi.fn(async () => rows);
  return { api: { collectRows } as unknown as QueryApi, collectRows };
}
function mockDatadis(consumption: unknown[] = []) {
  const get = vi.fn(async (path: string) => {
    if (path.includes('get-supplies')) return [{ cups: 'ES_CUPS', distributorCode: '2' }];
    if (path.includes('get-consumption-data')) return consumption;
    return [];
  });
  return { http: { get } as DatadisHttp, get };
}
const esios: EsiosHttp = { get: vi.fn(async () => ({ indicator: { values: [] } })) };

const from = new Date('2025-01-01T00:00:00Z');
const to = new Date('2025-01-31T00:00:00Z');

// ─── TC-PRE-015 — Anti-429: datos en InfluxDB evitan llamada a DATADIS ─────────

describe('TC-PRE-015 - anti-429 on-demand', () => {
  it('si InfluxDB cubre el rango, NO se llama a DATADIS', async () => {
    const { http, get } = mockDatadis();
    const ensure = makeOnDemandIngestion({
      hasCoverage: vi.fn(async () => true), // datos presentes
      datadis: http,
      esios,
      writeApi: mockWriteApi(),
      queryApi: mockQueryApi().api,
    });

    await ensure('ES_CUPS', from, to, 'T_2_0TD');
    expect(get).not.toHaveBeenCalled();
  });

  it('si faltan datos, se llama a DATADIS (consumo) para el rango', async () => {
    const { http, get } = mockDatadis();
    const ensure = makeOnDemandIngestion({
      hasCoverage: vi.fn(async () => false), // sin datos
      datadis: http,
      esios,
      writeApi: mockWriteApi(),
      queryApi: mockQueryApi().api,
    });

    await ensure('ES_CUPS', from, to, 'T_2_0TD');
    const consumptionCalls = get.mock.calls.filter(([p]) => String(p).includes('get-consumption-data'));
    expect(consumptionCalls).toHaveLength(1);
    expect((consumptionCalls[0][1] as Record<string, string>).startDate).toBe('2025/01');
  });

  it('3.0TD ademas solicita reactiva; 2.0TD no', async () => {
    const { http: http3, get: get3 } = mockDatadis();
    const ensure3 = makeOnDemandIngestion({ hasCoverage: vi.fn(async () => false), datadis: http3, esios, writeApi: mockWriteApi(), queryApi: mockQueryApi().api });
    await ensure3('ES_CUPS', from, to, 'T_3_0TD');
    expect(get3.mock.calls.some(([p]) => String(p).includes('get-reactive-data-v2'))).toBe(true);

    const { http: http2, get: get2 } = mockDatadis();
    const ensure2 = makeOnDemandIngestion({ hasCoverage: vi.fn(async () => false), datadis: http2, esios, writeApi: mockWriteApi(), queryApi: mockQueryApi().api });
    await ensure2('ES_CUPS', from, to, 'T_2_0TD');
    expect(get2.mock.calls.some(([p]) => String(p).includes('get-reactive-data-v2'))).toBe(false);
  });
});

// ─── Imputación enchufada: tras ingerir consumo con huecos, se imputan ─────────

describe('imputacion on-demand', () => {
  it('imputa las horas ausentes usando el valor de la semana anterior', async () => {
    // Ventana de 1 dia. DATADIS solo devuelve la hora 01:00 local (=00:00Z invierno).
    const dayFrom = new Date('2025-01-15T00:00:00Z');
    const dayTo = new Date('2025-01-16T00:00:00Z');
    const { http } = mockDatadis([
      { cups: 'ES_CUPS', date: '2025/01/15', time: '01:00', consumptionKWh: 3, obtainMethod: 'Real', surplusEnergyKWh: 0 },
    ]);
    const writeApi = mockWriteApi();
    // El lookup de la semana anterior siempre devuelve un valor → se imputa cada hueco.
    const { api: queryApi, collectRows } = mockQueryApi([{ _value: 2.0 }]);

    const ensure = makeOnDemandIngestion({
      hasCoverage: vi.fn(async () => false),
      datadis: http,
      esios,
      writeApi,
      queryApi,
    });

    await ensure('ES_CUPS', dayFrom, dayTo, 'T_2_0TD');

    // 23 horas ausentes → 23 lookups a InfluxDB (imputación intentada).
    expect(collectRows).toHaveBeenCalledTimes(23);
    // Se escribieron el punto de consumo (1) + los 23 imputados.
    expect(writeApi.writePoint.mock.calls.length).toBeGreaterThanOrEqual(24);
  });

  it('no imputa si DATADIS no devolvio ningun dato (NO_CONSUMPTION_DATA)', async () => {
    const { http } = mockDatadis([]); // consumo vacio
    const writeApi = mockWriteApi();
    const { api: queryApi, collectRows } = mockQueryApi([{ _value: 2.0 }]);

    const ensure = makeOnDemandIngestion({
      hasCoverage: vi.fn(async () => false),
      datadis: http,
      esios,
      writeApi,
      queryApi,
    });

    await ensure('ES_CUPS', new Date('2025-01-15T00:00:00Z'), new Date('2025-01-16T00:00:00Z'), 'T_2_0TD');
    // Sin consumo no se intenta imputar (guard).
    expect(collectRows).not.toHaveBeenCalled();
  });
});
