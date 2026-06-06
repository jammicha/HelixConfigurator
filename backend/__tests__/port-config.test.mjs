import { describe, it, expect } from 'vitest';
import { resolvePort } from '../portConfig.js';

describe('resolvePort', () => {
  it('defaults to 8765 when PORT is unset', () => {
    expect(resolvePort({})).toBe(8765);
  });
  it('honors a numeric PORT', () => {
    expect(resolvePort({ PORT: '3001' })).toBe(3001);
  });
  it('falls back to 8765 when PORT is non-numeric', () => {
    expect(resolvePort({ PORT: 'nope' })).toBe(8765);
  });
});
