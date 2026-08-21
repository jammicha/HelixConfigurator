// backend/__tests__/diagnostics-verify-fanout.test.mjs
//
// Route-level contract for POST /api/diagnostics/verify-fanout: it must
// answer 200 for every verdict, including when the underlying canary throws
// (see viewerCanary.js's poll loop, which calls otelStore.getTrace()
// unguarded).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

// diagnostics.js and viewerCanary.js are both CommonJS (require('axios')).
// vi.mock('axios') does not intercept CJS require calls from an .mjs test
// file, so instead we grab the same axios instance Node's require cache
// hands to both modules and patch it in place with vi.spyOn — same
// observable behaviour, no network. (Same technique as runOtlpProbe.test.mjs.)
const require = createRequire(import.meta.url);
const axios = require('axios');
const diagnostics = require('../routes/diagnostics.js');

const buildApp = (otelStore) => {
  const app = express();
  diagnostics.register(app, {
    docker: {},
    containerLogs: {},
    configPath: '/dev/null',
    otelStore,
  });
  return app;
};

describe('POST /api/diagnostics/verify-fanout', () => {
  let postSpy, getSpy;

  beforeEach(() => {
    postSpy = vi.spyOn(axios, 'post');
    getSpy = vi.spyOn(axios, 'get');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with an ok verdict and a counters object when the span round-trips', async () => {
    postSpy.mockResolvedValue({ status: 200 }); // gateway accepts the injected span
    getSpy.mockResolvedValue({
      data: 'otelcol_exporter_sent_spans_total{exporter="otlphttp/helix_local_viewer"} 3',
    });
    const otelStore = { getTrace: vi.fn(() => ({ summary: {}, spans: [{ spanId: 'a' }] })) };

    const res = await request(buildApp(otelStore)).post('/api/diagnostics/verify-fanout');

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('ok');
    expect(res.body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.counters).toEqual({ sent: 3, failed: 0 });
  });

  it('returns 200 (not a 4xx/5xx) for a failing verdict, e.g. gateway-unreachable', async () => {
    postSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const otelStore = { getTrace: vi.fn(() => null) };

    const res = await request(buildApp(otelStore)).post('/api/diagnostics/verify-fanout');

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('gateway-unreachable');
    expect(res.body.detail).toContain('ECONNREFUSED');
    // The canary never entered its poll loop, so no metrics read was needed;
    // the route still answers with the shape the UI expects.
    expect(res.body).toHaveProperty('counters');
  });

  it('returns 200 with verdict "error" (not a 500) when the canary throws mid-poll', async () => {
    postSpy.mockResolvedValue({ status: 200 }); // injection succeeds
    const otelStore = {
      getTrace: vi.fn(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      }),
    };

    const res = await request(buildApp(otelStore)).post('/api/diagnostics/verify-fanout');

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('error');
    expect(res.body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.detail).toContain('SQLITE_BUSY');
    expect(res.body.remediation).toBeTruthy();
    expect(res.body.counters).toBeNull();
    // The metrics endpoint must not even be hit on this path.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('leaves counters null when the metrics read fails, while the verdict still stands', async () => {
    postSpy.mockResolvedValue({ status: 200 });
    getSpy.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8889'));
    const otelStore = { getTrace: vi.fn(() => ({ summary: {}, spans: [{ spanId: 'a' }] })) };

    const res = await request(buildApp(otelStore)).post('/api/diagnostics/verify-fanout');

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('ok');
    expect(res.body.counters).toBeNull();
  });
});
