import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { register } from '../routes/step-zero/synthetic.js';

const makeApp = (deps = {}) => {
  const app = express();
  app.use(express.json());
  register(app, deps);
  return app;
};

describe('GET /api/step-zero/synthetic/status', () => {
  it('returns running: false and zero counters when idle', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/step-zero/synthetic/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      running: false,
      sent_traces: 0,
      sent_with_errors: 0,
    });
  });
});

import { __resetForTests } from '../routes/step-zero/synthetic.js';
import { beforeEach } from 'vitest';

beforeEach(() => { __resetForTests(); });

describe('POST /api/step-zero/synthetic/start', () => {
  const baseEnv = {
    HELIX_ENDPOINT: 'https://helixdemo.onbmc.com',
    HELIX_API_KEY: '1234567890::AK::SK',
    X_SOURCE: 'step-zero-demo',
  };

  it('starts a run via the gateway when the gateway probe succeeds', async () => {
    const probeGateway = vi.fn().mockResolvedValue(true);
    const readEnv = vi.fn().mockReturnValue(baseEnv);
    const send = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ probeGateway, readEnv, send });

    const r = await request(app).post('/api/step-zero/synthetic/start').send({});
    expect(r.status).toBe(200);
    expect(r.body.destination).toBe('gateway');
    expect(r.body.run_id).toMatch(/^[0-9a-f-]+$/);
    expect(r.body.helix_deep_link).toMatch(/helixdemo\.onbmc\.com/);
    expect(probeGateway).toHaveBeenCalled();
  });

  it('falls back to local when gateway is unreachable', async () => {
    const probeGateway = vi.fn().mockResolvedValue(false);
    const readEnv = vi.fn().mockReturnValue(baseEnv);
    const send = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ probeGateway, readEnv, send });

    const r = await request(app).post('/api/step-zero/synthetic/start').send({});
    expect(r.status).toBe(200);
    expect(r.body.destination).toBe('local');
    expect(r.body.helix_deep_link).toBe(null);
  });

  it('falls back to local when HELIX_ENDPOINT is missing', async () => {
    const probeGateway = vi.fn().mockResolvedValue(true);
    const readEnv = vi.fn().mockReturnValue({});
    const send = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ probeGateway, readEnv, send });

    const r = await request(app).post('/api/step-zero/synthetic/start').send({});
    expect(r.body.destination).toBe('local');
  });

  it('returns 409 when another run is already in progress', async () => {
    const probeGateway = vi.fn().mockResolvedValue(false);
    const readEnv = vi.fn().mockReturnValue(baseEnv);
    const send = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ probeGateway, readEnv, send });

    await request(app).post('/api/step-zero/synthetic/start').send({});
    const r = await request(app).post('/api/step-zero/synthetic/start').send({});
    expect(r.status).toBe(409);
  });

  it('records continuous flag from body', async () => {
    const app = makeApp({
      probeGateway: vi.fn().mockResolvedValue(false),
      readEnv: vi.fn().mockReturnValue(baseEnv),
      send: vi.fn().mockResolvedValue(undefined),
    });
    const r = await request(app).post('/api/step-zero/synthetic/start').send({ continuous: true });
    expect(r.body.expected_end_at).toBe(null);
    const status = await request(app).get('/api/step-zero/synthetic/status');
    expect(status.body.continuous).toBe(true);
  });
});

describe('POST /api/step-zero/synthetic/stop', () => {
  const baseEnv = { HELIX_ENDPOINT: 'https://helixdemo.onbmc.com', X_SOURCE: 'demo' };

  it('returns 404 when no run is active', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/step-zero/synthetic/stop').send({});
    expect(r.status).toBe(404);
  });

  it('marks the active run as stopped and returns the final stats', async () => {
    const app = makeApp({
      probeGateway: vi.fn().mockResolvedValue(false),
      readEnv: vi.fn().mockReturnValue(baseEnv),
      send: vi.fn().mockResolvedValue(undefined),
    });
    const start = await request(app).post('/api/step-zero/synthetic/start').send({});
    const r = await request(app).post('/api/step-zero/synthetic/stop').send({ run_id: start.body.run_id });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toBe(true);
    expect(r.body).toHaveProperty('sent_traces');
    expect(r.body).toHaveProperty('sent_with_errors');

    // Status reports running:false after stop.
    const status = await request(app).get('/api/step-zero/synthetic/status');
    expect(status.body.running).toBe(false);
  });

  it('rejects mismatched run_id with 409', async () => {
    const app = makeApp({
      probeGateway: vi.fn().mockResolvedValue(false),
      readEnv: vi.fn().mockReturnValue(baseEnv),
      send: vi.fn().mockResolvedValue(undefined),
    });
    await request(app).post('/api/step-zero/synthetic/start').send({});
    const r = await request(app).post('/api/step-zero/synthetic/stop').send({ run_id: 'wrong-id' });
    expect(r.status).toBe(409);
  });
});
