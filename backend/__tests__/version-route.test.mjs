// backend/__tests__/version-route.test.mjs
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import version from '../routes/version.js';

describe('GET /api/version', () => {
  it('reports current vs latest and whether an update exists', async () => {
    const app = express();
    version.register(app, { current: '1.0.5', fetchLatestTag: vi.fn(async () => 'v1.1.0') });
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('1.0.5');
    expect(res.body.latest).toBe('1.1.0');
    expect(res.body.updateAvailable).toBe(true);
  });
  it('degrades to updateAvailable=false when the check fails', async () => {
    const app = express();
    version.register(app, { current: '1.0.5', fetchLatestTag: vi.fn(async () => { throw new Error('offline'); }) });
    const res = await request(app).get('/api/version');
    expect(res.body.updateAvailable).toBe(false);
  });
});
