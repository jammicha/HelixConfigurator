import { describe, it, expect, vi } from 'vitest';
import { fetchCapabilityWithRetry } from './updateCapability';

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const CAP = { supported: false, mode: 'dev-checkout', hint: 'git pull, rebuild the frontend, restart.' };
const noSleep = async () => {};

describe('fetchCapabilityWithRetry', () => {
  it('returns the capability when the first attempt succeeds', async () => {
    const fetchImpl = vi.fn(async () => ok(CAP));
    const cap = await fetchCapabilityWithRetry(fetchImpl as never, { sleep: noSleep });
    expect(cap).toEqual(CAP);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The reported bug: a single blip while the backend was restarting left the
  // banner showing generic "re-run your install command" text for the life of
  // the page, because the fetch was one-shot and swallowed its error.
  it('recovers the real hint after a transient network failure', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(ok(CAP));
    const cap = await fetchCapabilityWithRetry(fetchImpl as never, { sleep: noSleep });
    expect(cap).toEqual(CAP);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a non-ok response, since a 401 or 502 is not a real answer', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })
      .mockResolvedValueOnce(ok(CAP));
    const cap = await fetchCapabilityWithRetry(fetchImpl as never, { sleep: noSleep });
    expect(cap).toEqual(CAP);
  });

  it('gives up and reports null once attempts are exhausted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const cap = await fetchCapabilityWithRetry(fetchImpl as never, { attempts: 3, sleep: noSleep });
    expect(cap).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry forever on a body that will not parse', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('not json'); } }));
    const cap = await fetchCapabilityWithRetry(fetchImpl as never, { attempts: 2, sleep: noSleep });
    expect(cap).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
