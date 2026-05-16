import { describe, it, expect, beforeEach } from 'vitest';
import { push, recent, _reset } from '../errorLog.js';

describe('errorLog', () => {
  beforeEach(() => { _reset(); });

  it('returns empty array when nothing pushed', () => {
    expect(recent()).toEqual([]);
  });

  it('returns pushed entries newest-first', () => {
    push('tag1', 'first message');
    push('tag2', 'second message');
    const entries = recent();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('second message');
    expect(entries[1].message).toBe('first message');
  });

  it('attaches a numeric timestamp to each entry', () => {
    const before = Date.now();
    push('t', 'm');
    const [entry] = recent();
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(Date.now());
  });

  it('respects the limit param', () => {
    for (let i = 0; i < 10; i++) push('t', `msg${i}`);
    expect(recent(3)).toHaveLength(3);
  });

  it('caps the buffer at 50 entries (oldest evicted)', () => {
    for (let i = 0; i < 60; i++) push('t', `msg${i}`);
    const entries = recent(100);
    expect(entries).toHaveLength(50);
    // Newest first; msg59 should be index 0, msg10 (the oldest survivor) should be last.
    expect(entries[0].message).toBe('msg59');
    expect(entries[49].message).toBe('msg10');
  });

  it('preserves optional detail field', () => {
    push('tag', 'message', { foo: 'bar' });
    expect(recent()[0].detail).toEqual({ foo: 'bar' });
  });
});
