import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConnectionsStore } = require('../connectionsStore.js');
const connRoutes = require('../routes/connections.js');

const SHIPPED_YAML = fs.readFileSync(path.join(process.cwd(), '..', 'helix-otel-collector.yaml'), 'utf8');
let dir, connectionsPath, envPath, configPath, recreateCalls;

const okDocker = () => ({
  getContainer: () => ({
    inspect: async () => ({ State: { Status: 'running', StartedAt: new Date(Date.now() - 5000).toISOString() }, Config: {}, HostConfig: {}, NetworkSettings: { Networks: {} } }),
    restart: async () => {}, stop: async () => {}, remove: async () => {}, start: async () => {},
  }),
  createContainer: async () => ({ start: async () => {} }),
  getNetwork: () => ({ connect: async () => {} }),
});

function makeApp() {
  const store = createConnectionsStore({ connectionsPath, envPath });
  const app = express();
  app.use(express.json());
  connRoutes.register(app, {
    docker: okDocker(), containerLogs: async () => '',
    configPath, connectionsPath, envPath, store,
    recreateGateway: async () => { recreateCalls++; },
  });
  return app;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-routes-'));
  connectionsPath = path.join(dir, 'connections.json');
  envPath = path.join(dir, '.env');
  configPath = path.join(dir, 'collector.yaml');
  fs.writeFileSync(configPath, SHIPPED_YAML, 'utf8');
  recreateCalls = 0;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const valid = { name: 'ACME Prod', endpoint: 'https://acme.onbmc.com', apiKey: 'T::A::S', xSource: 'acme-payments', signals: { traces: true, metrics: true, logs: true } };

describe('POST /api/connections', () => {
  it('creates, recreates the gateway, and writes a managed exporter into the yaml', async () => {
    const res = await request(makeApp()).post('/api/connections').send(valid);
    expect(res.status).toBe(200);
    expect(res.body.state.connections[0].id).toBe('acme-prod');
    expect(recreateCalls).toBe(1);
    const yamlAfter = fs.readFileSync(configPath, 'utf8');
    expect(yamlAfter).toContain('otlphttp/bmchelix_acme-prod:');
    // The shipped yaml wraps this comment across lines with a leading
    // "# and the per-trace..." prefix, so match on the stable substring
    // rather than assuming a leading "#" immediately precedes it.
    expect(yamlAfter).toContain("Don't remove this");
  });
  it('rejects invalid input with 400 and leaves the yaml untouched', async () => {
    const before = fs.readFileSync(configPath, 'utf8');
    const res = await request(makeApp()).post('/api/connections').send({ ...valid, endpoint: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.errors.endpoint).toBeTruthy();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(recreateCalls).toBe(0);
  });
});

describe('GET /api/connections', () => {
  it('lists connections without api keys', async () => {
    const app = makeApp();
    await request(app).post('/api/connections').send(valid);
    const res = await request(app).get('/api/connections');
    expect(res.body.activeId).toBe('acme-prod');
    expect(res.body.connections[0]).not.toHaveProperty('apiKey');
  });
});

describe('POST /api/connections/:id/activate', () => {
  it('sets active without recreating the gateway', async () => {
    const app = makeApp();
    await request(app).post('/api/connections').send(valid);
    await request(app).post('/api/connections').send({ ...valid, name: 'Beta', apiKey: 'B::A::S' });
    recreateCalls = 0;
    const res = await request(app).post('/api/connections/beta/activate');
    expect(res.status).toBe(200);
    expect(res.body.activeId).toBe('beta');
    expect(recreateCalls).toBe(0);
  });
});
