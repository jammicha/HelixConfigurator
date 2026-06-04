// backend/__tests__/k8s-helm-smoke.test.mjs
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
const SKELETON = path.join(PROJECT_ROOT, 'helix-otel');

function helmAvailable() {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function assembleChart(destRoot, viewerEnabled) {
  const dest = path.join(destRoot, 'helix-otel');
  fs.cpSync(SKELETON, dest, { recursive: true });
  const collectorYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'helix-otel-collector.yaml'), 'utf8');
  const { values, gatewayConfig } = buildChartFiles({ collectorYaml, endpoint: 'https://h/otlp', xSource: 'acme', viewerEnabled });
  fs.writeFileSync(path.join(dest, 'values.yaml'), values);
  fs.mkdirSync(path.join(dest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config', 'gateway-collector.yaml'), gatewayConfig);
  return dest;
}

describe.skipIf(!helmAvailable())('helm smoke', () => {
  for (const viewer of [true, false]) {
    it(`renders valid manifests (viewer=${viewer})`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-'));
      try {
        const chart = assembleChart(tmp, viewer);
        execFileSync('helm', ['lint', chart, '--set', 'helix.apiKey=dummy'], { stdio: 'pipe' });
        const out = execFileSync('helm', ['template', 'helix', chart, '--set', 'helix.apiKey=dummy'], { encoding: 'utf8' });
        const docs = yaml.loadAll(out).filter(Boolean);
        const kinds = docs.map(d => d.kind);
        expect(kinds).toContain('Deployment');
        expect(kinds).toContain('ConfigMap');
        expect(kinds).toContain('Secret');
        // Viewer objects present only when enabled.
        expect(kinds.includes('PersistentVolumeClaim')).toBe(viewer);
        // Gateway ConfigMap embeds the collector config.
        const cm = docs.find(d => d.kind === 'ConfigMap');
        expect(cm.data['config.yaml']).toMatch(/otlphttp\/bmchelix/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it('existingSecret mode: no chart-managed Secret, gateway refs the external one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-es-'));
    try {
      const chart = assembleChart(tmp, true);
      // No --set helix.apiKey: the key lives in a Secret the user pre-created.
      execFileSync('helm', ['lint', chart, '--set', 'helix.existingSecret=my-helix-key'], { stdio: 'pipe' });
      const out = execFileSync('helm', ['template', 'helix', chart, '--set', 'helix.existingSecret=my-helix-key'], { encoding: 'utf8' });
      const docs = yaml.loadAll(out).filter(Boolean);
      // The chart must NOT create its own Secret when an existing one is referenced.
      expect(docs.map(d => d.kind)).not.toContain('Secret');
      const dep = docs.find(d => d.kind === 'Deployment' && d.metadata.name === 'helix-gateway');
      const apiKeyEnv = dep.spec.template.spec.containers[0].env.find(e => e.name === 'HELIX_API_KEY');
      expect(apiKeyEnv.valueFrom.secretKeyRef.name).toBe('my-helix-key');
      expect(apiKeyEnv.valueFrom.secretKeyRef.key).toBe('HELIX_API_KEY');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
