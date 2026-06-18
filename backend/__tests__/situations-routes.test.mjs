import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import express from 'express';
const require = createRequire(import.meta.url);
const axios = require('axios');
const { register } = require('../routes/situations');

// situations.js reads process.env directly. Set a fresh key per test so the
// module-level Bearer cache doesn't bleed across tests.
let keyCounter = 0;
function setEnv() {
  keyCounter += 1;
  process.env.HELIX_ENDPOINT = 'https://acme.onbmc.com';
  process.env.HELIX_EVENTS_ENDPOINT = 'https://acme.onbmc.com';
  process.env.HELIX_API_KEY = `T${keyCounter}::AK::SK`;
}
function makeApp(otelStore = { getTrace: () => null }) {
  const app = express();
  app.use(express.json());
  register(app, { otelStore });
  return app;
}
function mockAxios({ hits = [] } = {}) {
  vi.spyOn(axios, 'post').mockImplementation(async (url) => {
    if (url.endsWith('/ims/api/v1/access_keys/login')) return { status: 200, data: { json_web_token: 'jwt' } };
    if (url.endsWith('/events/msearch')) return { status: 200, data: { hits: { hits } } };
    return { status: 404, data: {} };
  });
  const patchSpy = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { successfullEventIds: ['x'] } });
  return { patchSpy };
}

beforeEach(setEnv);
afterEach(() => vi.restoreAllMocks());

describe('POST /api/situations/convert-trace (eventIds capture)', () => {
  it('returns the created event ids from the ingest response', async () => {
    const fakeTrace = { summary: { service_name: 'redis-manual', service_namespace: 'hotrod', root_operation: 'op', duration_ms: 100, span_count: 1, trace_id: 'abc123', start_time_ns: 0, has_error: false }, spans: [] };
    vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/ims/api/v1/access_keys/login')) return { status: 200, data: { json_web_token: 'jwt' } };
      if (url.endsWith('/events-service/api/v1.0/events')) return { status: 200, data: { successfullEventIds: ['eps.1'] } };
      return { status: 404, data: {} };
    });
    const res = await request(makeApp({ getTrace: () => fakeTrace })).post('/api/situations/convert-trace').send({ traceId: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.eventIds).toEqual(['eps.1']);
    expect(res.body).toHaveProperty('noteWritten');
  });
});

describe('POST /api/situations/close-events', () => {
  it('412s when no API key is configured', async () => {
    delete process.env.HELIX_API_KEY;
    const res = await request(makeApp()).post('/api/situations/close-events').send({ all: true });
    expect(res.status).toBe(412);
  });

  it('searches by traceId then PATCHes each match to CLOSED', async () => {
    const { patchSpy } = mockAxios({ hits: [{ _id: 'eps.1' }, { _id: 'eps.2' }] });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ traceId: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(2);
    const closeCalls = patchSpy.mock.calls.filter(([, b]) => b && b.status === 'CLOSED');
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0][0]).toContain('/events-service/api/v1.0/events/eps.1');
  });

  it('closes by explicit eventIds without searching', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { json_web_token: 'jwt' } });
    vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {} });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ eventIds: ['eps.9'] });
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(1);
    expect(postSpy.mock.calls.some(([u]) => u.endsWith('/events/msearch'))).toBe(false);
  });

  it('soft-succeeds with closed:0 when nothing matches', async () => {
    mockAxios({ hits: [] });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ traceId: 'none' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, closed: 0 });
  });

  it('400s when neither traceId, all, nor eventIds is given', async () => {
    const res = await request(makeApp()).post('/api/situations/close-events').send({});
    expect(res.status).toBe(400);
  });
});
