import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { register } from '../routes/step-zero/instrument.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  register(app);
  return app;
};

describe('POST /api/step-zero/instrument/snippet', () => {
  it('returns compose + shell for a java/compose request', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'java', serviceName: 'my-app', endpointMode: 'compose',
    });
    expect(r.status).toBe(200);
    expect(r.body.compose).toContain('OTEL_SERVICE_NAME: my-app');
    expect(r.body.compose).toContain('helix-bridge');
    expect(r.body.shell).toContain('java -javaagent');
  });

  it('400s on invalid language', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'rust', serviceName: 'x', endpointMode: 'compose',
    });
    expect(r.status).toBe(400);
  });

  it('400s on invalid endpointMode', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'java', serviceName: 'x', endpointMode: 'kubernetes',
    });
    expect(r.status).toBe(400);
  });

  it('400s on missing serviceName', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'java', endpointMode: 'compose',
    });
    expect(r.status).toBe(400);
  });
});
