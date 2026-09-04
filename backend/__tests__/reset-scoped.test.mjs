import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeResetMode } = require('../routes/lifecycle.js');

describe('computeResetMode', () => {
  const ids = ['a', 'b', 'c'];
  it('is full when no selection is given', () => {
    expect(computeResetMode(undefined, ids)).toBe('full');
    expect(computeResetMode([], ids)).toBe('full');
  });
  it('is full when the selection covers every connection', () => {
    expect(computeResetMode(['a', 'b', 'c'], ids)).toBe('full');
  });
  it('is partial for a strict subset', () => {
    expect(computeResetMode(['b'], ids)).toBe('partial');
  });
});
