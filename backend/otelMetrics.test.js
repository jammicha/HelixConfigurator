import { describe, it, expect } from 'vitest';
import otelStoreModule from './otelStore.js';

const { extractMetricPoints, metricResourceKey } = otelStoreModule;

// A realistic OTLP/JSON metrics payload: two runtime metrics we keep (a gauge
// and a sum) plus one histogram we must ignore, under one resource.
const SAMPLE = {
  resourceMetrics: [{
    resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'cart' } },
      { key: 'service.namespace', value: { stringValue: 'shop' } },
    ] },
    scopeMetrics: [{
      metrics: [
        { name: 'process.cpu.utilization', gauge: { dataPoints: [
          { timeUnixNano: '1000000000', asDouble: 0.42 },
          { timeUnixNano: '2000000000', asDouble: 0.55 },
        ] } },
        { name: 'process.memory.usage', sum: { dataPoints: [
          { timeUnixNano: '1000000000', asInt: '104857600' },
        ] } },
        { name: 'http.server.duration', histogram: { dataPoints: [
          { timeUnixNano: '1000000000' },
        ] } },
      ],
    }],
  }],
};

describe('extractMetricPoints', () => {
  it('keeps only allowlisted process.* points, reads gauge+sum and asInt/asDouble', () => {
    const points = extractMetricPoints(SAMPLE);
    const key = metricResourceKey('shop', 'cart');

    // 2 cpu + 1 memory = 3; the histogram is dropped.
    expect(points).toHaveLength(3);
    expect(points.every(p => p.resourceKey === key)).toBe(true);

    const cpu = points.filter(p => p.metricName === 'process.cpu.utilization');
    expect(cpu.map(p => p.value)).toEqual([0.42, 0.55]);
    expect(cpu.map(p => p.tsNs)).toEqual([1_000_000_000, 2_000_000_000]);

    const mem = points.filter(p => p.metricName === 'process.memory.usage');
    expect(mem).toHaveLength(1);
    expect(mem[0].value).toBe(104857600);
  });

  it('returns [] for a body with no resourceMetrics', () => {
    expect(extractMetricPoints({})).toEqual([]);
    expect(extractMetricPoints(null)).toEqual([]);
  });
});
