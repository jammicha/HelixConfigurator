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
