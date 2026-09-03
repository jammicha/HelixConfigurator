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
let dir, connectionsPath, envPath, configPath;

// Container reports EXITED -> forces the settle-failure rollback branch.
const rejectingDocker = () => ({
  getContainer: () => ({
    inspect: async () => ({ State: { Status: 'exited', ExitCode: 1, StartedAt: new Date().toISOString() }, Config: {}, HostConfig: {}, NetworkSettings: { Networks: {} } }),
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
    docker: rejectingDocker(), containerLogs: async () => 'Error: bad config',
    configPath, connectionsPath, envPath, store, recreateGateway: async () => {},
  });
  return app;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rb-'));
  connectionsPath = path.join(dir, 'connections.json');
  envPath = path.join(dir, '.env');
  configPath = path.join(dir, 'collector.yaml');
  fs.writeFileSync(configPath, SHIPPED_YAML, 'utf8');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const valid = { name: 'ACME Prod', endpoint: 'https://acme.onbmc.com', apiKey: 'T::A::S', xSource: 'svc', signals: { traces: true, metrics: true, logs: true } };

it('rolls back json, env, and yaml when the collector rejects the change', async () => {
  const yamlBefore = fs.readFileSync(configPath, 'utf8');
  const res = await request(makeApp()).post('/api/connections').send(valid);
  expect(res.status).toBe(400);
  expect(res.body.rolledBack).toBe(true);
  expect(fs.readFileSync(configPath, 'utf8')).toBe(yamlBefore);
  expect(fs.existsSync(connectionsPath) ? fs.readFileSync(connectionsPath, 'utf8') : '').toBe('');
  const envAfter = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  expect(envAfter).not.toContain('HELIX_API_KEY_ACME_PROD');
});
