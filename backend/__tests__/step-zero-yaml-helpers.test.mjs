import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  addReceiverAndPipeline,
  hasReceiver,
} from '../routes/step-zero/yaml-helpers.js';

const BASE_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
service:
  pipelines:
    metrics:
      receivers:
        - otlp
      exporters:
        - otlphttp/bmchelix
`;

describe('hasReceiver', () => {
  it('returns false when receiver is absent', () => {
    expect(hasReceiver(BASE_YAML, 'hostmetrics')).toBe(false);
  });

  it('returns true when receiver is present', () => {
    const withReceiver = BASE_YAML.replace('receivers:', 'receivers:\n  hostmetrics:\n    collection_interval: 30s');
    expect(hasReceiver(withReceiver, 'hostmetrics')).toBe(true);
  });
});

describe('addReceiverAndPipeline', () => {
  it('adds the receiver under receivers:', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s', root_path: '/hostfs' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.receivers.hostmetrics).toEqual({
      collection_interval: '30s',
      root_path: '/hostfs',
    });
  });

  it('wires the receiver into a new pipeline under the requested signal', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.service.pipelines['metrics/host']).toEqual({
      receivers: ['hostmetrics'],
      exporters: ['otlphttp/bmchelix'],
    });
  });

  it('preserves the existing default metrics pipeline', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: {},
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.service.pipelines.metrics.receivers).toEqual(['otlp']);
  });

  it('is idempotent — adding the same receiver twice produces the same result', () => {
    const opts = {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    };
    const once = addReceiverAndPipeline(BASE_YAML, opts);
    const twice = addReceiverAndPipeline(once, opts);
    const p1 = yaml.load(once);
    const p2 = yaml.load(twice);
    expect(p2).toEqual(p1);
    expect(p2.service.pipelines['metrics/host'].receivers).toEqual(['hostmetrics']);
  });

  it('throws if pipelineSignal is not one of traces/metrics/logs', () => {
    expect(() => addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: {},
      pipelineName: 'bogus/host',
      pipelineSignal: 'bogus',
      exporters: ['otlphttp/bmchelix'],
    })).toThrow(/pipelineSignal/);
  });
});
