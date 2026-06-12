import { Point, type WriteApi } from '@influxdata/influxdb-client';

// Representación intermedia plana de un punto InfluxDB. Las funciones de transformación
// devuelven esto (testeable sin InfluxDB); writePoints lo convierte a Point y escribe.
export interface MeasurementPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, number>;
  timestamp: Date;
}

export function toInfluxPoint(mp: MeasurementPoint): Point {
  const point = new Point(mp.measurement);
  for (const [k, v] of Object.entries(mp.tags)) point.tag(k, v);
  for (const [k, v] of Object.entries(mp.fields)) point.floatField(k, v);
  point.timestamp(mp.timestamp);
  return point;
}

export function writePoints(writeApi: WriteApi, points: MeasurementPoint[]): void {
  for (const mp of points) {
    writeApi.writePoint(toInfluxPoint(mp));
  }
}
