// backend/__tests__/bridge-create-or-recreate.test.mjs
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import lifecycle from '../routes/lifecycle.js';

// lifecycle.js and viewerCanary.js are CommonJS (require('axios')), and
// vi.mock('axios') does not intercept CJS require from an .mjs test file.
// Patch the shared instance Node's require cache hands them, same technique
// as diagnostics-verify-fanout.test.mjs — no network, and in particular no
// traffic to whatever really is listening on 4318 on the dev machine.
const require = createRequire(import.meta.url);
const axios = require('axios');

function makeApp({ gatewayExists }) {
  const created = { fromScratch: false };
  const docker = {
    getContainer: () => ({
      inspect: vi.fn(async () => {
        if (gatewayExists) return { Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } };
        const e = new Error('no such container'); e.statusCode = 404; throw e;
      }),
      stop: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    }),
    createContainer: vi.fn(async () => ({ start: vi.fn(async () => { created.fromScratch = true; }) })),
    createNetwork: vi.fn(async () => {}),
    getImage: () => ({ inspect: vi.fn(async () => ({})) }), // image present → no pull
    getNetwork: () => ({ connect: vi.fn(async () => {}) }),
  };
  const app = express();
  app.use(express.json());
  lifecycle.register(app, { docker, configPath: '/opt/helix/helix-otel-collector.yaml' });
  return { app, created };
}

describe('POST /api/lifecycle/bridge', () => {
  it('creates from scratch when no gateway exists', async () => {
    const { app, created } = makeApp({ gatewayExists: false });
    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(created.fromScratch).toBe(true);
  });

  it('takes the recreate path (not from-scratch) when gateway already exists', async () => {
    // createGatewayFromScratch is the only path that calls createNetwork;
    // recreateGateway does not. Use that to distinguish the two paths.
    const createNetworkSpy = vi.fn(async () => {});
    const docker = {
      getContainer: () => ({
        inspect: vi.fn(async () => ({
          Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} },
        })),
        stop: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      }),
      createContainer: vi.fn(async () => ({ start: vi.fn(async () => {}) })),
      createNetwork: createNetworkSpy,
      getImage: () => ({ inspect: vi.fn(async () => ({})) }),
      getNetwork: () => ({ connect: vi.fn(async () => {}) }),
    };
    const app = express();
    app.use(express.json());
    lifecycle.register(app, { docker, configPath: '/opt/helix/helix-otel-collector.yaml' });

    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/recreated/i);
    // createGatewayFromScratch (and only it) calls createNetwork — must NOT be called
    expect(createNetworkSpy).not.toHaveBeenCalled();
  });

  it('returns 500 and does not attempt from-scratch create when inspect throws non-404', async () => {
    // Build an app where inspect() rejects with a 500-level error
    const docker = {
      getContainer: () => ({
        inspect: vi.fn(async () => {
          const e = new Error('internal docker error');
          e.statusCode = 500;
          throw e;
        }),
        stop: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      }),
      createContainer: vi.fn(async () => ({ start: vi.fn(async () => {}) })),
      createNetwork: vi.fn(async () => {}),
      getImage: () => ({ inspect: vi.fn(async () => ({})) }),
      getNetwork: () => ({ connect: vi.fn(async () => {}) }),
    };
    const app = express();
    app.use(express.json());
    lifecycle.register(app, { docker, configPath: '/opt/helix/helix-otel-collector.yaml' });

    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(500);
    // From-scratch create must NOT have been attempted
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});

describe('POST /api/lifecycle/bridge — viewer verdict in the response', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const writeTempCollectorYaml = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cfg-'));
    const cfg = path.join(dir, 'helix-otel-collector.yaml');
    fs.writeFileSync(cfg, 'exporters:\n  otlphttp/helix_local_viewer:\n    traces_endpoint: http://helix-configurator:3001/api/otlp/traces\n');
    return cfg;
  };

  it('returns the ladder verdict on the create path instead of discarding it', async () => {
    // Readiness probe answers immediately; the canary's OTLP injection is
    // refused, so the ladder returns gateway-unreachable on candidate 0.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: '' });
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4318'));

    const docker = {
      getContainer: () => ({
        inspect: vi.fn(async () => { const e = new Error('no such container'); e.statusCode = 404; throw e; }),
      }),
      createContainer: vi.fn(async () => ({ start: vi.fn(async () => {}), restart: vi.fn(async () => {}) })),
      createNetwork: vi.fn(async () => {}),
      getImage: () => ({ inspect: vi.fn(async () => ({})) }),
      getNetwork: () => ({ inspect: vi.fn(async () => ({ IPAM: { Config: [] } })) }),
    };
    const app = express();
    app.use(express.json());
    lifecycle.register(app, { docker, configPath: writeTempCollectorYaml(), otelStore: {} });

    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(res.body.viewer.verdict).toBe('gateway-unreachable');
    expect(res.body.viewer.endpoint).toBe(null);
    expect(res.body.viewer.attempts).toEqual([
      { endpoint: 'http://host.docker.internal:8765', verdict: 'gateway-unreachable' },
    ]);
    // Detail and remediation ride along so the Diagnostics cell the frontend
    // seeds from this can state a fix, not just a verdict string.
    expect(res.body.viewer.detail).toContain('ECONNREFUSED');
    expect(res.body.viewer.remediation).toMatch(/4318/);
  });

  it('answers viewer: null on the recreate path (the ladder is create-only)', async () => {
    const { app } = makeApp({ gatewayExists: true });
    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(res.body.viewer).toBe(null);
  });
});

describe('POST /api/lifecycle/bridge — on-disk fan-out endpoint', () => {
  // The rewrite is what makes the yaml agree with where the configurator is
  // actually reachable. It used to run only inside createGatewayFromScratch,
  // so in the compose deployment — where the gateway is created by compose
  // and this route only ever recreates — it never ran at all. It also never
  // ran for a user who set PORT after a collision, restarted, and pressed
  // Save. It is a read, a string replace and a rename; the canary ladder,
  // which is the expensive part, deliberately stays create-only.
  const writeTempCollectorYaml = (endpoint) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cfg-'));
    const cfg = path.join(dir, 'helix-otel-collector.yaml');
    fs.writeFileSync(cfg, `exporters:\n  otlphttp/helix_local_viewer:\n    traces_endpoint: ${endpoint}/api/otlp/traces\n`);
    return cfg;
  };

  const runBridge = async (cfg, { gatewayExists, bridgeIp = null }) => {
    const docker = {
      getContainer: () => ({
        inspect: vi.fn(async () => {
          if (gatewayExists) return { Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } };
          const e = new Error('no such container'); e.statusCode = 404; throw e;
        }),
        stop: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      }),
      createContainer: vi.fn(async () => ({ start: vi.fn(async () => {}) })),
      createNetwork: vi.fn(async () => {}),
      getImage: () => ({ inspect: vi.fn(async () => ({})) }),
      getNetwork: () => ({
        connect: vi.fn(async () => {}),
        inspect: vi.fn(async () => ({ IPAM: { Config: bridgeIp ? [{ Gateway: bridgeIp }] : [] } })),
      }),
    };
    const app = express();
    app.use(express.json());
    lifecycle.register(app, { docker, configPath: cfg });
    return request(app).post('/api/lifecycle/bridge').send({});
  };

  it('rewrites a stale container-direction endpoint on the RECREATE path', async () => {
    const cfg = writeTempCollectorYaml('http://helix-configurator:3001');
    const res = await runBridge(cfg, { gatewayExists: true });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('rewrites a stale PORT on the recreate path, so a post-collision PORT change takes effect', async () => {
    const prevPort = process.env.PORT;
    process.env.PORT = '9100';
    try {
      const cfg = writeTempCollectorYaml('http://host.docker.internal:8765');
      const res = await runBridge(cfg, { gatewayExists: true });
      expect(res.status).toBe(200);
      expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:9100/api/otlp/traces');
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it('still rewrites on the CREATE path', async () => {
    const cfg = writeTempCollectorYaml('http://helix-configurator:3001');
    const res = await runBridge(cfg, { gatewayExists: false });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('does NOT clobber a ladder-proven bridge-IP endpoint on the recreate path', async () => {
    // The create-time ladder falls through to the bridge gateway IP on hosts
    // where host.docker.internal does not resolve (Linux Docker Engine,
    // despite the injected ExtraHosts), and leaves that PROVEN endpoint on
    // disk. The ladder is create-only, so nothing re-derives it. A recreate
    // that unconditionally wrote candidate 0 would overwrite a working
    // endpoint with one the ladder had already disproved on this host — and
    // `viewer` is null on the recreate response, so nothing would report it.
    const cfg = writeTempCollectorYaml('http://172.30.0.1:8765');
    const res = await runBridge(cfg, { gatewayExists: true, bridgeIp: '172.30.0.1' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('http://172.30.0.1:8765/api/otlp/traces');
  });

  it('still rewrites a bridge-IP endpoint that is no longer a candidate (PORT moved)', async () => {
    // Preserving is scoped to endpoints that are still legitimate. A stale
    // port makes this one not a candidate any more, so item 3's rewrite must
    // still fire.
    const prevPort = process.env.PORT;
    process.env.PORT = '9100';
    try {
      const cfg = writeTempCollectorYaml('http://172.30.0.1:8765');
      const res = await runBridge(cfg, { gatewayExists: true, bridgeIp: '172.30.0.1' });
      expect(res.status).toBe(200);
      expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:9100/api/otlp/traces');
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it('rewrites a bridge IP that is not THIS host\'s bridge gateway', async () => {
    // A yaml carried over from another machine. 10.0.0.1 is not a candidate
    // here, so preserving it would strand the fan-out.
    const cfg = writeTempCollectorYaml('http://10.0.0.1:8765');
    const res = await runBridge(cfg, { gatewayExists: true, bridgeIp: '172.30.0.1' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('the CREATE path still writes candidate 0 over a bridge-IP endpoint', async () => {
    // createGatewayFromScratch passes skipFirstApply, which asserts that
    // candidate 0 is what is on disk and what the container loaded. Preserving
    // on create would break that invariant.
    const cfg = writeTempCollectorYaml('http://172.30.0.1:8765');
    const res = await runBridge(cfg, { gatewayExists: false, bridgeIp: '172.30.0.1' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('a rewrite failure (unreadable yaml) does not fail the request', async () => {
    const res = await runBridge('/nonexistent/dir/helix-otel-collector.yaml', { gatewayExists: true });
    expect(res.status).toBe(200);
  });
});
