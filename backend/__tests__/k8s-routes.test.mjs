// backend/__tests__/k8s-routes.test.mjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..'); // worktree root (contains helix-otel/)

const FIXTURE = `
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
service:
  pipelines:
    traces: { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:   { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

let tmpDir, configPath;
function makeApp() {
  const app = express();
  const { register } = require('../routes/k8s.js');
  register(app, { configPath, projectRoot: PROJECT_ROOT });
  return app;
}
// supertest binary collector
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let origApiKey;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-route-'));
  configPath = path.join(tmpDir, 'helix-otel-collector.yaml');
  fs.writeFileSync(configPath, FIXTURE);
  process.env.HELIX_ENDPOINT = 'https://helix.example/otlp';
  process.env.X_SOURCE = 'acme-otel';
  origApiKey = process.env.HELIX_API_KEY;
  process.env.HELIX_API_KEY = 'TENANT::ACCESS::SECRET';
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origApiKey === undefined) delete process.env.HELIX_API_KEY;
  else process.env.HELIX_API_KEY = origApiKey;
});

describe('GET /api/k8s/chart/preview', () => {
  it('returns generated values, gateway config, install command and file list', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?viewer=true');
    expect(res.status).toBe(200);
    expect(yaml.load(res.body.values).helix.endpoint).toBe('https://helix.example/otlp');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer'].traces_endpoint)
      .toBe('http://helix-viewer:3001/api/otlp/traces');
    expect(res.body.installCommand).toMatch(/helm install helix \.\/helix-otel/);
    expect(res.body.installCommand).toMatch(/existingSecret/);
    // Default: the live key is pre-filled into the create-secret command.
    expect(res.body.installCommand).toContain("HELIX_API_KEY='TENANT::ACCESS::SECRET'");
    expect(res.body.keyEmbedded).toBe(true);
    expect(res.body.files).toContain('helix-otel/templates/gateway-deployment.yaml');
  });

  it('viewer=false strips the viewer exporter in the previewed config', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?viewer=false');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });

  it('returns 400 on malformed live collector YAML', async () => {
    fs.writeFileSync(configPath, ':\n::');
    const res = await request(makeApp()).get('/api/k8s/chart/preview');
    expect(res.status).toBe(400);
    fs.writeFileSync(configPath, FIXTURE); // restore
  });

  it('handoff mode omits the real key (placeholder only)', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?handoff=true');
    expect(res.status).toBe(200);
    expect(res.body.keyEmbedded).toBe(false);
    expect(res.body.installCommand).toContain('<TenantID::AccessKey::SecretKey>');
    expect(res.body.installCommand).not.toContain('TENANT::ACCESS::SECRET');
  });

  it('does not crash at register or preview when the chart skeleton is missing (regression)', async () => {
    // Guards the bug where listChartFiles ran eagerly at register() and threw
    // ENOENT — crashing the whole backend at startup — when helix-otel/ wasn't
    // present (e.g. not copied into the Docker image).
    const app = express();
    const { register } = require('../routes/k8s.js');
    expect(() => register(app, { configPath, projectRoot: '/no/such/dir' })).not.toThrow();
    const res = await request(app).get('/api/k8s/chart/preview?viewer=true');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual(expect.arrayContaining([
      'helix-otel/values.yaml',
      'helix-otel/config/gateway-collector.yaml',
    ]));
  });
});

describe('GET /api/k8s/chart', () => {
  it('streams a zip containing the full chart with the generated files', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart?viewer=true')
      .buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/helix-otel-chart\.zip/);

    const names = new AdmZip(res.body).getEntries().map(e => e.entryName);
    for (const f of [
      'helix-otel/Chart.yaml',
      'helix-otel/values.yaml',
      'helix-otel/config/gateway-collector.yaml',
      'helix-otel/templates/gateway-deployment.yaml',
      'helix-otel/templates/secret.yaml',
      'helix-otel/templates/viewer-pvc.yaml',
    ]) expect(names).toContain(f);

    // Non-template generated files parse as YAML.
    const zip = new AdmZip(res.body);
    expect(yaml.load(zip.getEntry('helix-otel/values.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/config/gateway-collector.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/Chart.yaml').getData().toString()).name).toBe('helix-otel');

    // Preview file list must match the zip's file entries exactly.
    const fileEntries = new AdmZip(res.body).getEntries()
      .filter(e => !e.isDirectory)
      .map(e => e.entryName)
      .sort();
    const preview = await request(makeApp()).get('/api/k8s/chart/preview?viewer=true');
    expect(preview.body.files).toContain('helix-otel/templates/gateway-deployment.yaml');
    expect(preview.body.files.slice().sort()).toEqual(fileEntries);
  });
});
