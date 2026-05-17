import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from '../routes/step-zero/agentless.js';

export const BASE_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
service:
  pipelines:
    metrics:
      receivers:
        - otlp
      exporters:
        - otlphttp/bmchelix
`;

export const makeApp = (deps) => {
  const app = express();
  app.use(express.json());
  register(app, deps);
  return app;
};

export const tmpConfig = (yamlText = BASE_YAML) => {
  const p = path.join(os.tmpdir(), `step-zero-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, yamlText, 'utf8');
  return p;
};

describe('GET /api/step-zero/agentless/status', () => {
  it('returns enabled=false for hostmetrics and dockerstats when base config', async () => {
    const configPath = tmpConfig();
    const app = makeApp({ docker: { listContainers: vi.fn().mockResolvedValue([]) }, configPath });
    const r = await request(app).get('/api/step-zero/agentless/status');
    expect(r.status).toBe(200);
    expect(r.body.hostmetrics.enabled).toBe(false);
    expect(r.body.dockerstats.enabled).toBe(false);
  });

  it('returns enabled=true after the receiver is added to YAML', async () => {
    const configPath = tmpConfig(BASE_YAML.replace('receivers:', 'receivers:\n  hostmetrics:\n    root_path: /hostfs'));
    const app = makeApp({ docker: { listContainers: vi.fn().mockResolvedValue([]) }, configPath });
    const r = await request(app).get('/api/step-zero/agentless/status');
    expect(r.body.hostmetrics.enabled).toBe(true);
    expect(r.body.dockerstats.enabled).toBe(false);
  });
});
