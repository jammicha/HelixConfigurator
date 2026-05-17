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

describe('POST /api/step-zero/agentless/hostmetrics/enable', () => {
  it('writes hostmetrics receiver into the YAML and reports success', async () => {
    const configPath = tmpConfig();
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn().mockReturnValue({
        restart: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'running', StartedAt: new Date(Date.now() - 3000).toISOString() } }),
      }),
    };
    const containerLogs = vi.fn().mockResolvedValue('');
    const app = makeApp({ docker, configPath, containerLogs });
    const r = await request(app).post('/api/step-zero/agentless/hostmetrics/enable').send({});
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const newYaml = fs.readFileSync(configPath, 'utf8');
    expect(newYaml).toMatch(/hostmetrics:/);
    expect(newYaml).toMatch(/root_path: \/hostfs/);
    expect(newYaml).toMatch(/metrics\/host:/);
  });

  it('rolls back the YAML if the gateway fails to come back up', async () => {
    const configPath = tmpConfig();
    const originalYaml = fs.readFileSync(configPath, 'utf8');
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn().mockReturnValue({
        restart: vi.fn().mockResolvedValue(undefined),
        // Container exits — waitForGatewaySettle returns running:false.
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'exited', ExitCode: 1, StartedAt: new Date().toISOString() } }),
      }),
    };
    const containerLogs = vi.fn().mockResolvedValue('Error: invalid receiver config');
    const app = makeApp({ docker, configPath, containerLogs });
    const r = await request(app).post('/api/step-zero/agentless/hostmetrics/enable').send({});
    expect(r.status).toBe(500);
    expect(r.body.rolledBack).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalYaml);
  });
});
