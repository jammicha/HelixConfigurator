// backend/__tests__/update-route.test.mjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, registerPublicRoutes, detectCapability, PLATFORM_ASSETS, PRESERVED_ENTRIES } = require('../routes/update.js');
const { resolveGatewayOtlpBase, resolveGatewayMetricsBase } = require('../util.js');

let nativeRoot; // temp dir shaped like a native install (has a bundled ./node)
let devRoot;    // temp dir shaped like a dev checkout (no bundled runtime)

beforeAll(() => {
  nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-native-'));
  fs.writeFileSync(path.join(nativeRoot, 'node'), '#!/bin/sh\n');
  devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-dev-'));
});
afterAll(() => {
  fs.rmSync(nativeRoot, { recursive: true, force: true });
  fs.rmSync(devRoot, { recursive: true, force: true });
});

describe('detectCapability', () => {
  it('reports docker mode (with compose hint) inside the container', () => {
    const c = detectCapability({ platform: 'linux', arch: 'x64', installRoot: nativeRoot, appDirExists: true });
    expect(c.supported).toBe(false);
    expect(c.mode).toBe('docker');
    expect(c.hint).toMatch(/docker compose/);
  });

  it('supports native darwin-arm64 with the matching release asset', () => {
    const c = detectCapability({ platform: 'darwin', arch: 'arm64', installRoot: nativeRoot, appDirExists: false });
    expect(c).toEqual({ supported: true, mode: 'native', asset: 'helix-configurator-darwin-arm64.zip' });
  });

  it('supports native linux-x64 with the matching release asset', () => {
    const c = detectCapability({ platform: 'linux', arch: 'x64', installRoot: nativeRoot, appDirExists: false });
    expect(c).toEqual({ supported: true, mode: 'native', asset: 'helix-configurator-linux-amd64.zip' });
  });

  it('declines Windows (file locking) but still knows its asset exists', () => {
    const c = detectCapability({ platform: 'win32', arch: 'x64', installRoot: nativeRoot, appDirExists: false });
    expect(c.supported).toBe(false);
    expect(c.mode).toBe('windows');
    expect(PLATFORM_ASSETS['win32-x64']).toBe('helix-configurator-windows-amd64.zip');
  });

  it('declines unknown platforms', () => {
    const c = detectCapability({ platform: 'freebsd', arch: 'x64', installRoot: nativeRoot, appDirExists: false });
    expect(c.supported).toBe(false);
    expect(c.mode).toBe('unsupported-platform');
  });

  it('declines a dev checkout (no bundled runtime at the install root)', () => {
    const c = detectCapability({ platform: 'darwin', arch: 'arm64', installRoot: devRoot, appDirExists: false });
    expect(c.supported).toBe(false);
    expect(c.mode).toBe('dev-checkout');
  });
});

describe('preserved user state', () => {
  it('never swaps .env, data/, the collector yaml, or the update workspace', () => {
    for (const must of ['.env', 'data', 'helix-otel-collector.yaml', '.update']) {
      expect(PRESERVED_ENTRIES).toContain(must);
    }
  });
});

describe('routes', () => {
  it('status starts idle; start refuses where self-update is unsupported', async () => {
    const app = express();
    register(app, { currentVersion: '1.0.0', installRoot: devRoot }); // dev checkout → unsupported
    const status = await request(app).get('/api/update/status');
    expect(status.body.phase).toBe('idle');
    const start = await request(app).post('/api/update/start');
    // In a real container this is mode:docker; in this test it's dev-checkout —
    // either way the route must refuse rather than half-update.
    expect(start.status).toBe(400);
    expect(start.body.supported).toBe(false);
    const apply = await request(app).post('/api/update/apply');
    expect(apply.status).toBe(409);
  });
});

describe('resolveGatewayOtlpBase / resolveGatewayMetricsBase', () => {
  it('uses published host ports for native installs', () => {
    expect(resolveGatewayOtlpBase({ containerized: false })).toBe('http://localhost:4318');
    expect(resolveGatewayMetricsBase({ containerized: false })).toBe('http://localhost:8888');
  });
  it('uses container DNS inside the Docker image', () => {
    expect(resolveGatewayOtlpBase({ containerized: true, targetName: 'helix-gateway' })).toBe('http://helix-gateway:4318');
    expect(resolveGatewayMetricsBase({ containerized: true, targetName: 'custom-gw' })).toBe('http://custom-gw:8888');
  });
  it('honors explicit overrides and strips trailing slashes', () => {
    expect(resolveGatewayOtlpBase({ override: 'http://10.0.0.5:4318///' })).toBe('http://10.0.0.5:4318');
  });
});

// The update banner is deliberately usable without signing in: /api/version is
// registered ahead of the auth gate for exactly that reason. The capability
// probe has to sit on the same side of the gate, or a password-protected
// install shows "update available" and can never show the button that applies
// it. The endpoints that actually MUTATE the install must stay behind it.
describe('capability probe vs the auth gate', () => {
  // Mirrors backend/index.js: public routes, then the gate, then the rest.
  const appWithAuthGate = (installRoot) => {
    const app = express();
    registerPublicRoutes(app, { currentVersion: '1.0.0', installRoot });
    app.use('/api', (req, res) => res.status(401).json({ error: 'auth required' }));
    register(app, { currentVersion: '1.0.0', installRoot });
    return app;
  };

  it('serves the capability probe without credentials', async () => {
    const res = await request(appWithAuthGate(nativeRoot)).get('/api/update/capability');
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    expect(res.body.mode).toBe('native');
  });

  it('still reports an unsupported install without credentials, with its hint', async () => {
    const res = await request(appWithAuthGate(devRoot)).get('/api/update/capability');
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(false);
    expect(res.body.hint).toBeTruthy();
  });

  it('keeps the mutating endpoints behind the gate', async () => {
    const app = appWithAuthGate(nativeRoot);
    expect((await request(app).post('/api/update/start')).status).toBe(401);
    expect((await request(app).post('/api/update/apply')).status).toBe(401);
  });
});
