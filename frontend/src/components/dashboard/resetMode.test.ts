import { describe, it, expect } from 'vitest';
import { computeResetMode } from './resetMode';

describe('computeResetMode', () => {
  const all = ['a', 'b', 'c'];
  it('is full for an empty selection', () => { expect(computeResetMode([], all)).toBe('full'); });
  it('is full when every connection is selected', () => { expect(computeResetMode(['a', 'b', 'c'], all)).toBe('full'); });
  it('is full when every connection is selected in a different order', () => { expect(computeResetMode(['c', 'a', 'b'], all)).toBe('full'); });
  it('is partial for a subset', () => { expect(computeResetMode(['a'], all)).toBe('partial'); });
  it('is partial for a multi-item subset', () => { expect(computeResetMode(['a', 'b'], all)).toBe('partial'); });
  it('is full when allIds is empty regardless of selection', () => { expect(computeResetMode([], [])).toBe('full'); });
});
