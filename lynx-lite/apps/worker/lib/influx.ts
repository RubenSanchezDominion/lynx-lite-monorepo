import { InfluxDB, type WriteApi, type QueryApi } from '@influxdata/influxdb-client';

const url = process.env.INFLUXDB_URL ?? 'http://localhost:8086';
const token = process.env.INFLUXDB_TOKEN ?? 'dev-token';
const org = process.env.INFLUXDB_ORG ?? 'lynx';
const bucket = process.env.INFLUXDB_BUCKET ?? 'lynx-lite';

const client = new InfluxDB({ url, token });

export const writeApi: WriteApi = client.getWriteApi(org, bucket, 'ns');
export const queryApi: QueryApi = client.getQueryApi(org);

export const influxConfig = { url, token, org, bucket };
