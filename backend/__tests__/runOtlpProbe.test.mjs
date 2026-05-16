import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { runOtlpProbe } from '../routes/diagnostics.js';

// diagnostics.js is CommonJS (require('axios')). vi.mock('axios') does not
// intercept CJS require calls from an .mjs test file. Instead we obtain the
// same axios instance that Node's require cache gives to diagnostics.js and
// use vi.spyOn to patch it in place — same observable behaviour, no network.
const require = createRequire(import.meta.url);
const axios = require('axios');

describe('runOtlpProbe', () => {
  let postSpy;

  beforeEach(() => {
    postSpy = vi.spyOn(axios, 'post');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns valid on 200', async () => {
    postSpy.mockResolvedValue({ status: 200 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('valid');
    expect(r.httpStatus).toBe(200);
    expect(typeof r.latencyMs).toBe('number');
  });

  it('returns rejected on 401', async () => {
    postSpy.mockResolvedValue({ status: 401 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('rejected');
    expect(r.httpStatus).toBe(401);
  });

  it('returns rejected on 403', async () => {
    postSpy.mockResolvedValue({ status: 403 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('rejected');
    expect(r.httpStatus).toBe(403);
  });

  it('returns tenant-error on other 4xx', async () => {
    postSpy.mockResolvedValue({ status: 404 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('tenant-error');
  });

  it('returns helix-error on 5xx', async () => {
    postSpy.mockResolvedValue({ status: 502 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('helix-error');
  });

  it('returns network-error on ECONNREFUSED', async () => {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:443');
    e.code = 'ECONNREFUSED';
    postSpy.mockRejectedValue(e);
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('network-error');
  });

  it('returns network-error on timeout', async () => {
    const e = new Error('timeout of 8000ms exceeded');
    e.code = 'ECONNABORTED';
    postSpy.mockRejectedValue(e);
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('network-error');
  });
});
