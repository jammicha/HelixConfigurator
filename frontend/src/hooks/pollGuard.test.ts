import { describe, it, expect, vi } from 'vitest';
import { createPollGuard } from './pollGuard';

// Let pending microtasks (the guard's internal async settler) flush.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createPollGuard', () => {
  it('runs the first call and skips overlapping calls while one is in flight', async () => {
    const g = createPollGuard();
    let release!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => { release = r; }));

    expect(g.run(fn)).toBe(true);   // first call runs
    expect(g.pending).toBe(true);
    expect(g.run(fn)).toBe(false);  // skipped — prior still pending
    expect(g.run(fn)).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(g.pending).toBe(false);
    expect(g.run(fn)).toBe(true);   // runs again once the prior settled
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('settles the guard even when the polled fn rejects', async () => {
    const g = createPollGuard();
    expect(g.run(() => Promise.reject(new Error('boom')))).toBe(true);
    await flush();
    expect(g.pending).toBe(false); // not wedged shut by the failure
    expect(g.run(() => Promise.resolve())).toBe(true);
  });

  it('settles the guard even when the polled fn throws synchronously', async () => {
    const g = createPollGuard();
    expect(g.run(() => { throw new Error('sync boom'); })).toBe(true);
    await flush();
    expect(g.pending).toBe(false);
    expect(g.run(() => Promise.resolve())).toBe(true);
  });
});
