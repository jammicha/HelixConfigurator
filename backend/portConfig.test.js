import { describe, it, expect } from 'vitest';
import portConfig from './portConfig.js';

const { resolveHost } = portConfig;

describe('resolveHost', () => {
  it('returns null when HOST is unset (dual-stack default)', () => {
    expect(resolveHost({})).toBe(null);
  });
  it('returns the HOST value when set', () => {
    expect(resolveHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
  it('treats empty string as unset', () => {
    expect(resolveHost({ HOST: '' })).toBe(null);
  });
});
