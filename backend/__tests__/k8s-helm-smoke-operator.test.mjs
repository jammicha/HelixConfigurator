// backend/__tests__/k8s-helm-smoke-operator.test.mjs
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { buildChartFiles } from '../k8sChart/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKELETON = path.join(PROJECT_ROOT, 'helix-otel-operator');

function helmAvailable() {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function assembleChart(destRoot, { target = 'local', languages } = {}) {
  const dest = path.join(destRoot, 'helix-otel-operator');
  fs.cpSync(SKELETON, dest, { recursive: true });
  const collectorYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'helix-otel-collector.yaml'), 'utf8');
  const { values, gatewayConfig } = buildChartFiles({ collectorYaml, endpoint: 'https://h/otlp', xSource: 'acme', target, engine: 'operator', languages });
  fs.writeFileSync(path.join(dest, 'values.yaml'), values);
  fs.mkdirSync(path.join(dest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config', 'gateway-collector.yaml'), gatewayConfig);
  return dest;
}

function template(chart, sets = ['helix.apiKey=dummy']) {
  const args = ['template', 'helix', chart];
  for (const s of sets) args.push('--set', s);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8' })).filter(Boolean);
}

describe.skipIf(!helmAvailable())('helm smoke (operator)', () => {
  it('lints and renders the CRs + alias Service + Secret', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-'));
    try {
      const chart = assembleChart(tmp);
      execFileSync('helm', ['lint', chart, '--set', 'helix.apiKey=dummy'], { stdio: 'pipe' });
      const docs = template(chart);
      const kinds = docs.map(d => d.kind);
      expect(kinds).toContain('OpenTelemetryCollector');
      expect(kinds).toContain('Instrumentation');
      expect(kinds).toContain('Secret');

      const col = docs.find(d => d.kind === 'OpenTelemetryCollector');
      expect(col.spec.mode).toBe('deployment');
      expect(typeof col.spec.config).toBe('object');
      expect(col.spec.config.exporters['otlphttp/bmchelix']).toBeDefined();

      const inst = docs.find(d => d.kind === 'Instrumentation');
      expect(inst.spec.exporter.endpoint).toMatch(/helix-gateway\..*\.svc\.cluster\.local:4318/);
      expect(inst.spec).toHaveProperty('java');
      expect(inst.spec).toHaveProperty('nodejs');
      expect(inst.spec).toHaveProperty('python');
      expect(inst.spec).toHaveProperty('dotnet');

      const alias = docs.find(d => d.kind === 'Service' && d.metadata.name === 'helix-gateway');
      expect(alias).toBeTruthy();
      expect(alias.spec.ports.map(p => p.port).sort()).toEqual([4317, 4318]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('omits disabled language blocks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-lang-'));
    try {
      const chart = assembleChart(tmp);
      const docs = template(chart, ['helix.apiKey=dummy', 'instrumentation.languages.python=false', 'instrumentation.languages.dotnet=false']);
      const inst = docs.find(d => d.kind === 'Instrumentation');
      expect(inst.spec).toHaveProperty('java');
      expect(inst.spec).not.toHaveProperty('python');
      expect(inst.spec).not.toHaveProperty('dotnet');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('existingSecret mode: no chart Secret, collector env refs the external one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-es-'));
    try {
      const chart = assembleChart(tmp);
      const docs = template(chart, ['helix.existingSecret=my-helix-key']);
      expect(docs.map(d => d.kind)).not.toContain('Secret');
      const col = docs.find(d => d.kind === 'OpenTelemetryCollector');
      const apiKeyEnv = col.spec.env.find(e => e.name === 'HELIX_API_KEY');
      expect(apiKeyEnv.valueFrom.secretKeyRef.name).toBe('my-helix-key');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
