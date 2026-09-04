// Route-level coverage for POST /api/lifecycle/reset-onboarding: partial vs
// full mode, mounted through the real lifecycle.register with a real
// connectionsStore over temp files.
//
// lifecycle.js reads/writes a module-scoped ENV_PATH constant (the repo
// root .env) directly - it is not an injectable option the way configPath
// and store are. That constant is also what index.js hands the real
// connectionsStore as its envPath in production, so the two always agree
// there. To keep this test from ever touching the developer's real .env
// file, fs.promises.readFile/writeFile are patched (same shared
// require('fs').promises object every module in this process sees) to
// redirect only calls for that specific absolute path into an in-memory
// buffer, and to point the test's own connectionsStore at that same path
// so it agrees with lifecycle.js exactly like index.js does. Every other
// path (connectionsPath, configPath) passes through to the real
// filesystem, in a per-test temp dir.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fsp = require('fs').promises;
const realReadFile = fsp.readFile.bind(fsp);
const realWriteFile = fsp.writeFile.bind(fsp);

// Spy on the synthetic run's clearActiveRun BEFORE lifecycle.js is required,
// so lifecycle's `const { clearActiveRun: clearSyntheticRun } =
// require('./step-zero/synthetic')` destructures the spied function. Both
// requires resolve to the same cached module.exports object.
const synthetic = require('../routes/step-zero/synthetic.js');
const clearSyntheticSpy = vi.spyOn(synthetic, 'clearActiveRun');

const lifecycle = require('../routes/lifecycle.js');
const { createConnectionsStore } = require('../connectionsStore.js');

const SHIPPED_YAML = fs.readFileSync(path.join(process.cwd(), '..', 'helix-otel-collector.yaml'), 'utf8');

// Matches lifecycle.js's own ENV_PATH: path.join(__dirname, '..', '..', '.env')
// from backend/routes, i.e. <repoRoot>/.env.
const REAL_ENV_PATH = path.resolve(process.cwd(), '..', '.env');

let dir, connectionsPath, configPath, fakeEnvContent;

const okDocker = () => ({
  getContainer: () => ({
    inspect: async () => ({ Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } }),
    stop: async () => {}, remove: async () => {},
  }),
  createContainer: async () => ({ start: async () => {} }),
  getNetwork: () => ({ connect: async () => {} }),
});

function makeApp(store) {
  const app = express();
  app.use(express.json());
  lifecycle.register(app, { docker: okDocker(), configPath, otelStore: {}, store });
  return app;
}

const conn = (name, xSource) => ({
  name,
  endpoint: `https://${xSource}.onbmc.com`,
  apiKey: 'T::A::S',
  xSource,
  signals: { traces: true, metrics: true, logs: true },
});

async function seedConnections(store, specs) {
  for (const spec of specs) await store.create(spec);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-onboarding-'));
  connectionsPath = path.join(dir, 'connections.json');
  configPath = path.join(dir, 'collector.yaml');
  fs.writeFileSync(configPath, SHIPPED_YAML, 'utf8');
  fakeEnvContent = '';
  clearSyntheticSpy.mockClear();

  vi.spyOn(fsp, 'readFile').mockImplementation(async (p, ...rest) => {
    if (p === REAL_ENV_PATH) return fakeEnvContent;
    return realReadFile(p, ...rest);
  });
  vi.spyOn(fsp, 'writeFile').mockImplementation(async (p, data, ...rest) => {
    if (p === REAL_ENV_PATH) { fakeEnvContent = data; return undefined; }
    return realWriteFile(p, data, ...rest);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/lifecycle/reset-onboarding - partial mode', () => {
  it('removes only the selected connections, leaves the others, and does not touch the synthetic run', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta'), conn('Gamma', 'gamma')]);

    const res = await request(makeApp(store))
      .post('/api/lifecycle/reset-onboarding')
      .send({ connectionIds: ['beta'] });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('partial');
    expect(res.body.deleted).toEqual(['beta']);

    const onDisk = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
    expect(onDisk.connections.map((c) => c.id).sort()).toEqual(['acme', 'gamma']);

    // Partial reset is not a full teardown: the synthetic run is untouched.
    expect(clearSyntheticSpy).not.toHaveBeenCalled();
  });

  it('reports only the ids that actually named a connection, not a stale id verbatim', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta'), conn('Gamma', 'gamma')]);

    const res = await request(makeApp(store))
      .post('/api/lifecycle/reset-onboarding')
      .send({ connectionIds: ['beta', 'does-not-exist'] });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('partial');
    expect(res.body.deleted).toEqual(['beta']);

    const onDisk = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
    expect(onDisk.connections.map((c) => c.id).sort()).toEqual(['acme', 'gamma']);
  });

  it('rewrites the managed yaml to only the remaining enabled connections', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta')]);

    const res = await request(makeApp(store))
      .post('/api/lifecycle/reset-onboarding')
      .send({ connectionIds: ['beta'] });

    expect(res.status).toBe(200);
    const yamlAfter = fs.readFileSync(configPath, 'utf8');
    expect(yamlAfter).toContain('otlphttp/bmchelix_acme:');
    expect(yamlAfter).not.toContain('otlphttp/bmchelix_beta:');
  });

  it('a recreate failure after the store/yaml changes committed is best-effort, not a total failure', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta')]);

    const flakyDocker = {
      getContainer: () => ({
        inspect: async () => ({ Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } }),
        stop: async () => {}, remove: async () => {},
      }),
      createContainer: async () => { throw new Error('daemon unreachable'); },
      getNetwork: () => ({ connect: async () => {} }),
    };
    const app = express();
    app.use(express.json());
    lifecycle.register(app, { docker: flakyDocker, configPath, otelStore: {}, store });

    const res = await request(app).post('/api/lifecycle/reset-onboarding').send({ connectionIds: ['beta'] });

    // The connection removal and yaml rewrite already committed to disk, so
    // this must NOT read as a total failure - it is a 200 carrying
    // recreateError, mirroring how full mode reports a recreate failure.
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('partial');
    expect(res.body.deleted).toEqual(['beta']);
    expect(res.body.recreateError).toMatch(/daemon unreachable/);

    const onDisk = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
    expect(onDisk.connections.map((c) => c.id)).toEqual(['acme']);
    const yamlAfter = fs.readFileSync(configPath, 'utf8');
    expect(yamlAfter).not.toContain('otlphttp/bmchelix_beta:');
  });
});

describe('POST /api/lifecycle/reset-onboarding - full mode', () => {
  it('empty body empties connections.json, reports mode full, and clears the synthetic run', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta')]);

    const res = await request(makeApp(store)).post('/api/lifecycle/reset-onboarding').send({});

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('full');
    expect(res.body.activeId).toBe(null);
    expect(res.body.deleted.sort()).toEqual(['acme', 'beta']);

    const onDisk = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
    expect(onDisk.connections).toEqual([]);
    expect(onDisk.activeId).toBe(null);

    expect(clearSyntheticSpy).toHaveBeenCalledTimes(1);
  });

  it('a selection covering every connection is treated as full, not partial', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath: REAL_ENV_PATH });
    await seedConnections(store, [conn('Acme', 'acme'), conn('Beta', 'beta')]);

    const res = await request(makeApp(store))
      .post('/api/lifecycle/reset-onboarding')
      .send({ connectionIds: ['acme', 'beta'] });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('full');
    const onDisk = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
    expect(onDisk.connections).toEqual([]);
  });
});
