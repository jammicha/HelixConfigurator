// backend/__tests__/create-gateway.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createGatewayFromScratch } from '../routes/lifecycle.js';

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
    expect(docker.calls.pulled).toBe('otel/opentelemetry-collector-contrib:latest');
    expect(docker.calls.networkCreated).toBe(true);
    expect(docker.calls.createArgs.Image).toBe('otel/opentelemetry-collector-contrib:latest');
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
