// backend/__tests__/bridge-create-or-recreate.test.mjs
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import lifecycle from '../routes/lifecycle.js';

function makeApp({ gatewayExists }) {
  const created = { fromScratch: false };
  const docker = {
    getContainer: () => ({
      inspect: vi.fn(async () => {
        if (gatewayExists) return { Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } };
        const e = new Error('no such container'); e.statusCode = 404; throw e;
      }),
      stop: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    }),
    createContainer: vi.fn(async () => ({ start: vi.fn(async () => { created.fromScratch = true; }) })),
    createNetwork: vi.fn(async () => {}),
    getImage: () => ({ inspect: vi.fn(async () => ({})) }), // image present → no pull
    getNetwork: () => ({ connect: vi.fn(async () => {}) }),
  };
  const app = express();
  app.use(express.json());
  lifecycle.register(app, { docker, configPath: '/opt/helix/helix-otel-collector.yaml' });
  return { app, created };
}

describe('POST /api/lifecycle/bridge', () => {
  it('creates from scratch when no gateway exists', async () => {
    const { app, created } = makeApp({ gatewayExists: false });
    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(created.fromScratch).toBe(true);
  });
});
