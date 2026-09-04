// desktop/__tests__/backend.test.js
import { describe, it, expect } from 'vitest';
import backend from '../backend.js';

const { waitForHealth } = backend;

function fakeFetch(sequence) {
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (step === 'throw') throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ ok: step === 'ok' }) };
  };
}

describe('waitForHealth', () => {
  it('resolves once health returns ok', async () => {
    const fetchImpl = fakeFetch(['throw', 'notok', 'ok']);
    await expect(
      waitForHealth('http://127.0.0.1:1', { timeoutMs: 1000, intervalMs: 5, fetchImpl })
    ).resolves.toBeUndefined();
  });

  it('rejects on timeout when health never becomes ok', async () => {
    const fetchImpl = fakeFetch(['throw']);
    await expect(
      waitForHealth('http://127.0.0.1:1', { timeoutMs: 30, intervalMs: 5, fetchImpl })
    ).rejects.toThrow(/timed out/i);
  });
});
