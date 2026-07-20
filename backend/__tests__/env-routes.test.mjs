import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const envRoutes = require('../routes/env.js');

function makeApp(envPath) {
  const app = express();
  app.use(express.json());
  envRoutes.register(app, { envPath });
  return app;
}

describe('/api/env', () => {
  let envPath;

  beforeEach(() => {
    envPath = path.join(os.tmpdir(), `helix-env-route-${process.pid}-${Date.now()}`);
  });

  afterEach(() => {
    try { fs.unlinkSync(envPath); } catch { /* ignore */ }
  });

  it('GET returns empty defaults when .env is missing (fresh native install)', async () => {
    const res = await request(makeApp(envPath)).get('/api/env');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      HELIX_ENDPOINT: '',
      HELIX_API_KEY: '',
      X_SOURCE: '',
      BUSINESS_SERVICE_KEY: '',
      HELIX_EVENTS_ENDPOINT: '',
    });
  });

  it('POST creates .env when missing and persists creds', async () => {
    const app = makeApp(envPath);
    const body = {
      HELIX_ENDPOINT: 'https://tenant.example.onbmc.com',
      HELIX_API_KEY: 'T::A::S',
      X_SOURCE: 'checkout',
    };
    const res = await request(app).post('/api/env').send(body);
    expect(res.status).toBe(200);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toContain('HELIX_ENDPOINT=https://tenant.example.onbmc.com');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('X_SOURCE=checkout');

    const getRes = await request(app).get('/api/env');
    expect(getRes.body.HELIX_ENDPOINT).toBe('https://tenant.example.onbmc.com');
    expect(getRes.body.X_SOURCE).toBe('checkout');
  });

  it('POST trims values written to disk and loaded into process.env', async () => {
    const prev = {
      HELIX_ENDPOINT: process.env.HELIX_ENDPOINT,
      X_SOURCE: process.env.X_SOURCE,
    };
    const app = makeApp(envPath);
    const res = await request(app).post('/api/env').send({
      HELIX_ENDPOINT: 'https://tenant.example.onbmc.com/ ',
      HELIX_API_KEY: 'T::A::S',
      X_SOURCE: ' checkout ',
    });
    expect(res.status).toBe(200);
    expect(process.env.HELIX_ENDPOINT).toBe('https://tenant.example.onbmc.com/');
    expect(process.env.X_SOURCE).toBe('checkout');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('X_SOURCE=checkout');

    if (prev.HELIX_ENDPOINT === undefined) delete process.env.HELIX_ENDPOINT;
    else process.env.HELIX_ENDPOINT = prev.HELIX_ENDPOINT;
    if (prev.X_SOURCE === undefined) delete process.env.X_SOURCE;
    else process.env.X_SOURCE = prev.X_SOURCE;
  });
});
