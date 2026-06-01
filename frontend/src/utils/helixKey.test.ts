import { describe, it, expect } from 'vitest';
import { parseHelixKeyBundle, extractServiceKey } from './helixKey';

describe('parseHelixKeyBundle', () => {
  it('rebuilds the canonical key from a pasted bundle (any order)', () => {
    expect(parseHelixKeyBundle('Key details: AAA::BBB, Tenant ID: 12345'))
      .toBe('12345::AAA::BBB');
    expect(parseHelixKeyBundle('Tenant ID: 999\nKey details: ABC::DEF'))
      .toBe('999::ABC::DEF');
  });

  it('returns null when the blob is not a recognizable bundle', () => {
    expect(parseHelixKeyBundle('')).toBeNull();
    expect(parseHelixKeyBundle('just some text')).toBeNull();
    expect(parseHelixKeyBundle('Key details: AAA::BBB')).toBeNull(); // no tenant
  });
});

describe('extractServiceKey', () => {
  it('returns a bare key unchanged', () => {
    expect(extractServiceKey('OPAQUEKEY123')).toBe('OPAQUEKEY123');
  });

  it('pulls the key out of a full AIOps URL or path fragment', () => {
    expect(extractServiceKey('https://tenant.onbmc.com/aiops/#/entities/service/KEY9?type=key'))
      .toBe('KEY9');
    expect(extractServiceKey('/entities/service/ABC123')).toBe('ABC123');
  });

  it('trims whitespace and strips trailing query/hash', () => {
    expect(extractServiceKey('  KEY1?type=key ')).toBe('KEY1');
    expect(extractServiceKey('')).toBe('');
  });
});
