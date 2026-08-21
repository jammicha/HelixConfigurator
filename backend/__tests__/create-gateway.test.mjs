// backend/__tests__/create-gateway.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { createGatewayFromScratch } from '../routes/lifecycle.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// lifecycle.js reaches errorLog via require(); use the same CJS instance here
// so we observe the buffer createGatewayFromScratch actually writes to (a
// plain ESM import resolves to a separate module instance under vitest).
const require = createRequire(import.meta.url);
const errorLog = require('../errorLog.js');

function mockDocker() {
  const calls = { pulled: false, networkCreated: false, started: false, createArgs: null };
  const fakeContainer = { start: vi.fn(async () => { calls.started = true; }) };
  return {
    calls,
    pull: vi.fn((img, cb) => { calls.pulled = img; cb(null, { resume() {} }); }),
    modem: { followProgress: (s, done) => done(null) },
    createNetwork: vi.fn(async () => { calls.networkCreated = true; }),
    createContainer: vi.fn(async (spec) => { calls.createArgs = spec; return fakeContainer; }),
    getImage: () => ({ inspect: vi.fn(async () => { throw { statusCode: 404 }; }) }),
  };
}

describe('createGatewayFromScratch', () => {
  it('pulls the image, ensures the network, creates and starts the gateway', async () => {
    const docker = mockDocker();
    await createGatewayFromScratch(docker, {
      name: 'helix-gateway',
      env: ['X_SOURCE=svc'],
      configHostPath: '/opt/helix/helix-otel-collector.yaml',
    });
    expect(docker.calls.pulled).toBe('otel/opentelemetry-collector-contrib:0.119.0');
    expect(docker.calls.networkCreated).toBe(true);
    expect(docker.calls.createArgs.Image).toBe('otel/opentelemetry-collector-contrib:0.119.0');
    expect(docker.calls.started).toBe(true);
  });

  it('tolerates an already-existing network (409)', async () => {
    const docker = mockDocker();
    docker.createNetwork = vi.fn(async () => { const e = new Error('exists'); e.statusCode = 409; throw e; });
    await expect(createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: '/x.yaml',
    })).resolves.not.toThrow();
  });
});

describe('createGatewayFromScratch — start failure cleanup', () => {
  it('removes the container (force) when start() rejects, then rethrows', async () => {
    const docker = mockDocker();
    const removeSpy = vi.fn(async () => {});
    const startError = new Error('start failed');
    docker.createContainer = vi.fn(async () => ({
      start: vi.fn(async () => { throw startError; }),
      remove: removeSpy,
    }));
    await expect(
      createGatewayFromScratch(docker, { name: 'helix-gateway', env: [], configHostPath: '/x.yaml' }),
    ).rejects.toThrow('start failed');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith({ force: true });
  });
});

// A docker instance whose container also exposes restart(), and whose
// helix-bridge network inspect returns a gateway IP — enough for
// viewerCandidates() to offer a second (bridgeIp) candidate so the ladder's
// fall-through and restart path actually gets exercised.
function mockDockerWithViewerSupport() {
  const docker = mockDocker();
  const fakeContainer = {
    start: vi.fn(async () => { docker.calls.started = true; }),
    restart: vi.fn(async () => {}),
  };
  docker.createContainer = vi.fn(async (spec) => { docker.calls.createArgs = spec; return fakeContainer; });
  docker.getNetwork = vi.fn(() => ({
    inspect: vi.fn(async () => ({ IPAM: { Config: [{ Gateway: '172.30.0.1' }] } })),
  }));
  return { docker, fakeContainer };
}

const writeTempCollectorYaml = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cfg-'));
  const cfg = path.join(dir, 'helix-otel-collector.yaml');
  fs.writeFileSync(cfg, `exporters:\n  otlphttp/helix_local_viewer:\n    traces_endpoint: http://helix-configurator:3001/api/otlp/traces\n`);
  return cfg;
};

describe('createGatewayFromScratch — viewer ladder integration', () => {
  it('waits for readiness before the first canary probe and again after the restart, in that order', async () => {
    const { docker, fakeContainer } = mockDockerWithViewerSupport();
    const cfg = writeTempCollectorYaml();
    // A shared order log, written to by each collaborator as it fires, is
    // what actually pins "readiness is awaited before the first canary call,
    // and again after each restart" — a bare toHaveBeenCalled() on
    // waitForReady would still pass if either call site were deleted, since
    // it fires twice either way. Ordering is what a regression would break.
    const order = [];
    const canary = vi.fn()
      .mockImplementationOnce(async () => { order.push('canary:1'); return { verdict: 'fanout-failed' }; })
      .mockImplementationOnce(async () => { order.push('canary:2'); return { verdict: 'ok' }; });
    const waitForReady = vi.fn(async () => { order.push('waitForReady'); });
    fakeContainer.restart = vi.fn(async () => { order.push('restart'); });

    const result = await createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: cfg, otelStore: {},
      canary, waitForReady,
    });

    expect(result.viewer.verdict).toBe('ok');
    // Candidate 0 (host.docker.internal) is skipped for write+restart since
    // the pre-create rewrite already put it on disk; only the fallback
    // bridge-IP candidate triggers a real restart. waitForReady runs exactly
    // twice: once before candidate 0's canary probe, once after the restart
    // that precedes candidate 1's.
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(canary).toHaveBeenCalledTimes(2);
    expect(fakeContainer.restart).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['waitForReady', 'canary:1', 'restart', 'waitForReady', 'canary:2']);
  });

  it('falls back to a single candidate when the bridge network cannot be inspected (no getNetwork on the docker double)', async () => {
    const docker = mockDocker(); // no getNetwork() at all — resolveBridgeGatewayIp must swallow that and return null
    const cfg = writeTempCollectorYaml();
    const canary = vi.fn(async () => ({ verdict: 'ok' }));
    const waitForReady = vi.fn(async () => {});

    const result = await createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: cfg, otelStore: {},
      canary, waitForReady,
    });

    expect(result.viewer.verdict).toBe('ok');
    expect(result.viewer.attempts).toEqual([
      { endpoint: 'http://host.docker.internal:8765', verdict: 'ok' },
    ]);
  });

  it('resolves rather than throwing when the injected canary rejects on every candidate, and logs the unproven verdict', async () => {
    errorLog._reset();
    const { docker } = mockDockerWithViewerSupport();
    const cfg = writeTempCollectorYaml();
    const canary = vi.fn(async () => { throw new Error('canary blew up'); });
    const waitForReady = vi.fn(async () => {});

    const promise = createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: cfg, otelStore: {},
      canary, waitForReady,
    });
    await expect(promise).resolves.toBeDefined();
    const result = await promise;
    expect(result.viewer.verdict).toBe('fanout-failed');
    // The ladder itself swallows the thrown canary error into a failed
    // attempt (never propagating), so this is createGatewayFromScratch's own
    // "verdict !== ok" branch firing, not its outer catch.
    expect(errorLog.recent(1)[0].tag).toBe('gateway.viewer.unproven');
  });

  it('skips the ladder entirely when otelStore is not provided (pre-existing callers)', async () => {
    const { docker } = mockDockerWithViewerSupport();
    const cfg = writeTempCollectorYaml();
    const canary = vi.fn();
    const result = await createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: cfg, canary,
    });
    expect(result).toEqual({ viewer: null });
    expect(canary).not.toHaveBeenCalled();
  });
});
