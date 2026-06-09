// backend/__tests__/k8sChart-values.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { renderValues, DEFAULTS } from '../k8sChart/renderValues.js';

describe('renderValues', () => {
  it('bakes live endpoint + xSource and never bakes the apiKey', () => {
    const v = yaml.load(renderValues({ endpoint: 'https://helix.example/otlp', xSource: 'acme-otel' }));
    expect(v.helix.endpoint).toBe('https://helix.example/otlp');
    expect(v.helix.xSource).toBe('acme-otel');
    expect(v.helix.apiKey).toBe('');
    expect(v.helix.existingSecret).toBe('');
    expect(v.helix.existingSecretKey).toBe('HELIX_API_KEY');
  });

  it('does not emit a viewer section', () => {
    const v = yaml.load(renderValues({}));
    expect(v.viewer).toBeUndefined();
  });

  it('emits stable gateway name and a pinned gateway image', () => {
    const v = yaml.load(renderValues({}));
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.gateway.image.repository).toBe('otel/opentelemetry-collector-contrib');
    expect(v.gateway.image.tag).toBe(DEFAULTS.collectorTag);
  });

  it('produces valid YAML with empty defaults when no live env is supplied', () => {
    const v = yaml.load(renderValues({}));
    expect(v.helix.endpoint).toBe('');
    expect(v.gateway.replicas).toBe(1);
  });
});

// --- appended: operator engine ---
import { renderValues as rv2 } from '../k8sChart/renderValues.js';

describe('renderValues (engine=operator)', () => {
  it('emits instrumentation languages (all four on) and empty image overrides', () => {
    const v = yaml.load(rv2({ endpoint: 'https://h/otlp', xSource: 'acme', engine: 'operator' }));
    expect(v.instrumentation.languages).toEqual({ java: true, nodejs: true, python: true, dotnet: true });
    expect(v.instrumentation.images).toEqual({ java: '', nodejs: '', python: '', dotnet: '' });
  });

  it('bakes endpoint/xSource, never the apiKey, and sets aliasService', () => {
    const v = yaml.load(rv2({ endpoint: 'https://h/otlp', xSource: 'acme', engine: 'operator' }));
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(v.helix.xSource).toBe('acme');
    expect(v.helix.apiKey).toBe('');
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.gateway.aliasService).toBe(true);
  });

  it('respects an explicit languages override', () => {
    const v = yaml.load(rv2({ engine: 'operator', languages: { java: true, nodejs: false, python: false, dotnet: false } }));
    expect(v.instrumentation.languages).toEqual({ java: true, nodejs: false, python: false, dotnet: false });
  });

  it('engine=deployment (default) is unchanged — no instrumentation key', () => {
    const v = yaml.load(rv2({ endpoint: 'x' }));
    expect(v.instrumentation).toBeUndefined();
    expect(v.gateway.service.type).toBe('ClusterIP');
  });
});
