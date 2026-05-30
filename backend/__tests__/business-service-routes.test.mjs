import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import express from 'express';
const require = createRequire(import.meta.url);
const { register } = require('../routes/business-service');

const ENV = { HELIX_ENDPOINT: 'https://acme.onbmc.com', HELIX_API_KEY: 'T1::AK::SK', X_SOURCE: 'fallback-src' };

function makeApp({ otelStore = { listNamespaces: () => [] }, env = ENV, envPath } = {}) {
  const app = express();
  app.use(express.json());
  register(app, { otelStore, env, envPath });
  return app;
}

describe('GET /api/business-service/namespaces', () => {
  it('lists namespaces, mapping null → X_SOURCE with a fallback flag', async () => {
    const otelStore = { listNamespaces: () => [{ namespace: 'shop', traceCount: 3, lastSeen: 2 }, { namespace: null, traceCount: 1, lastSeen: 1 }] };
    const res = await request(makeApp({ otelStore })).get('/api/business-service/namespaces');
    expect(res.status).toBe(200);
    expect(res.body.namespaces).toEqual([
      { namespace: 'shop', traceCount: 3, lastSeen: 2, fallback: false },
      { namespace: 'fallback-src', traceCount: 1, lastSeen: 1, fallback: true },
    ]);
  });
});

describe('GET /api/business-service/bind-instructions', () => {
  it('returns the AIOps link, dashboard URL, and steps for the namespace', async () => {
    const res = await request(makeApp()).get('/api/business-service/bind-instructions?namespace=shop');
    expect(res.status).toBe(200);
    expect(res.body.aiopsUrl).toBe('https://acme.onbmc.com/aiops/');
    expect(res.body.namespace).toBe('shop');
    expect(new URL(res.body.dashboardUrl).searchParams.get('orgId')).toBe('T1');
    expect(res.body.steps).toHaveLength(5);
  });
});

describe('POST /api/business-service/persist-key', () => {
  let file;
  beforeEach(() => { file = path.join(os.tmpdir(), `bs-env-${process.pid}-${Math.floor(performance.now())}`); fs.writeFileSync(file, 'A=1\n'); });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  it('extracts the key from a pasted AIOps URL, writes .env + in-memory env (no restart)', async () => {
    const env = { ...ENV };
    const res = await request(makeApp({ env, envPath: file }))
      .post('/api/business-service/persist-key')
      .send({ key: 'https://acme.onbmc.com/aiops/#/entities/service/RE-7?type=key' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, businessServiceKey: 'RE-7' });
    expect(env.BUSINESS_SERVICE_KEY).toBe('RE-7');
    expect(fs.readFileSync(file, 'utf8')).toContain('BUSINESS_SERVICE_KEY=RE-7');
  });
  it('400 on an empty key', async () => {
    const res = await request(makeApp({ envPath: file })).post('/api/business-service/persist-key').send({ key: '' });
    expect(res.status).toBe(400);
  });
});
