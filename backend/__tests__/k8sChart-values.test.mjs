// backend/__tests__/k8sChart-values.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { renderValues, DEFAULTS } from '../k8sChart/renderValues.js';

describe('renderValues', () => {
  it('bakes live endpoint + xSource and never bakes the apiKey', () => {
    const v = yaml.load(renderValues({ endpoint: 'https://helix.example/otlp', xSource: 'acme-otel', viewerEnabled: true }));
    expect(v.helix.endpoint).toBe('https://helix.example/otlp');
    expect(v.helix.xSource).toBe('acme-otel');
    expect(v.helix.apiKey).toBe('');
    // The recommended path references a pre-created Secret (empty by default).
    expect(v.helix.existingSecret).toBe('');
    expect(v.helix.existingSecretKey).toBe('HELIX_API_KEY');
  });

  it('reflects the viewer toggle', () => {
    expect(yaml.load(renderValues({ viewerEnabled: false })).viewer.enabled).toBe(false);
    expect(yaml.load(renderValues({ viewerEnabled: true })).viewer.enabled).toBe(true);
  });

  it('emits stable resource names and a pinned gateway image', () => {
    const v = yaml.load(renderValues({}));
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.viewer.name).toBe('helix-viewer');
    expect(v.gateway.image.repository).toBe('otel/opentelemetry-collector-contrib');
    expect(v.gateway.image.tag).toBe(DEFAULTS.collectorTag);
    expect(v.viewer.image.repository).toBe('helix-configurator');
    expect(v.viewer.image.pullPolicy).toBe('IfNotPresent');
  });

  it('produces valid YAML with empty defaults when no live env is supplied', () => {
    const v = yaml.load(renderValues({}));
    expect(v.helix.endpoint).toBe('');
    expect(v.viewer.persistence.size).toBe('2Gi');
  });
});
