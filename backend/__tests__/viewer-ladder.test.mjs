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

  it('skipFirstApply proves candidate 0 without writing or restarting, but still writes and restarts for later candidates', async () => {
    const fsp = makeFsp('yaml-for:http://a:1'); // caller already wrote candidate 0 on disk
    const canary = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fanout-failed' })
      .mockResolvedValueOnce({ verdict: 'ok' });
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite, skipFirstApply: true,
    });
    expect(r.endpoint).toBe('http://b:2');
    expect(fsp.writeFile).toHaveBeenCalledTimes(1); // only for candidate 1, not candidate 0
    expect(restartGateway).toHaveBeenCalledTimes(1); // only for candidate 1
    expect(fsp.state.yaml).toBe('yaml-for:http://b:2');
  });

  it('converts a thrown error mid-ladder into a failed attempt, keeps walking, and still restores candidate 0', async () => {
    const fsp = makeFsp('original');
    const restartGateway = vi.fn()
      .mockRejectedValueOnce(new Error('docker restart timed out'))
      .mockResolvedValueOnce(undefined);
    const canary = vi.fn(async () => ({ verdict: 'fanout-failed' }));
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe(null);
    expect(r.attempts).toEqual([
      { endpoint: 'http://a:1', verdict: 'fanout-failed', error: 'docker restart timed out' },
      { endpoint: 'http://b:2', verdict: 'fanout-failed' },
    ]);
    // canary only ran for the candidate whose restart succeeded
    expect(canary).toHaveBeenCalledOnce();
    // nothing threw out of selectViewerEndpoint, and the restore still ran
    expect(fsp.state.yaml).toBe('yaml-for:http://a:1');
  });

  it('does not throw when the candidates[0] restore write itself fails, and reports the failure instead of discarding it', async () => {
    const fsp = makeFsp('original');
    let writeFileCalls = 0;
    fsp.writeFile = vi.fn(async (_p, data) => {
      writeFileCalls += 1;
      // The first two writeFile calls are the two candidate attempts below;
      // the third is the candidates[0] restore, which is the one under test.
      if (writeFileCalls === 3) throw new Error('ENOSPC: no space left on device');
      fsp.state.pending = data;
    });
    const canary = vi.fn(async () => ({ verdict: 'fanout-failed' }));
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    // Selection itself did not throw, and the normal failure payload
    // (endpoint/verdict/attempts) is intact — the caller can still tell
    // "no candidate worked" from the attempts array.
    expect(r.endpoint).toBe(null);
    expect(r.verdict).toBe('fanout-failed');
    expect(r.attempts).toHaveLength(2);
    // ...and separately, that the restore itself also failed, rather than
    // that failure vanishing silently.
    expect(r.restoreError).toBe('ENOSPC: no space left on device');
    // The failed restore never renamed, so disk still holds candidate 1's
    // content, not candidate 0's.
    expect(fsp.state.yaml).toBe('yaml-for:http://b:2');
  });
});
