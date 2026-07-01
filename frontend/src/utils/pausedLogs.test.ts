import { describe, it, expect } from 'vitest';
import { mergePausedLogs, LOG_CAP } from './pausedLogs';

describe('mergePausedLogs', () => {
  it('appends buffered lines after the existing logs in order', () => {
    expect(mergePausedLogs(['a', 'b'], ['c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the existing logs unchanged when nothing was buffered', () => {
    expect(mergePausedLogs(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('keeps only the most recent LOG_CAP lines after merging', () => {
    const logs = Array.from({ length: LOG_CAP }, (_, i) => `old-${i}`);
    const buffered = ['new-1', 'new-2', 'new-3'];
    const merged = mergePausedLogs(logs, buffered);
    expect(merged).toHaveLength(LOG_CAP);
    // The three buffered lines survive; the three oldest are evicted.
    expect(merged.slice(-3)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(merged).not.toContain('old-0');
    expect(merged).not.toContain('old-2');
    expect(merged[0]).toBe('old-3');
  });

  it('honours a custom cap', () => {
    expect(mergePausedLogs(['a', 'b', 'c'], ['d'], 2)).toEqual(['c', 'd']);
  });
});
