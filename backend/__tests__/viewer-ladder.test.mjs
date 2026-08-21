import { describe, it, expect, vi } from 'vitest';
import { selectViewerEndpoint } from '../viewerLadder.js';

// Minimal fs promises double backed by a string.
const makeFsp = (initial) => {
  const state = { yaml: initial };
  return {
    state,
    readFile: vi.fn(async () => state.yaml),
    writeFile: vi.fn(async (_p, data) => { state.pending = data; }),
    rename: vi.fn(async () => { state.yaml = state.pending; }),
  };
};

const rewrite = (yaml, target) => `yaml-for:${target}`;

describe('selectViewerEndpoint', () => {
  it('keeps the first candidate when it round-trips', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'ok' }));
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe('http://a:1');
    expect(r.verdict).toBe('ok');
    expect(canary).toHaveBeenCalledOnce();
    expect(fsp.state.yaml).toBe('yaml-for:http://a:1');
  });

  it('falls through to the next candidate and persists the one that works', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fanout-failed' })
      .mockResolvedValueOnce({ verdict: 'ok' });
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe('http://b:2');
    expect(r.attempts).toEqual([
      { endpoint: 'http://a:1', verdict: 'fanout-failed' },
      { endpoint: 'http://b:2', verdict: 'ok' },
    ]);
    expect(fsp.state.yaml).toBe('yaml-for:http://b:2');
    expect(restartGateway).toHaveBeenCalledTimes(2);
  });

  it('stops immediately when the gateway itself is unreachable', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'gateway-unreachable' }));
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway: vi.fn(async () => {}), fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe(null);
    expect(r.verdict).toBe('gateway-unreachable');
    expect(canary).toHaveBeenCalledOnce();
  });

  it('leaves the first candidate written when every candidate fails', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'fanout-failed' }));
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway: vi.fn(async () => {}), fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe(null);
    expect(r.verdict).toBe('fanout-failed');
    expect(r.attempts).toHaveLength(2);
    expect(fsp.state.yaml).toBe('yaml-for:http://a:1');
  });
});
