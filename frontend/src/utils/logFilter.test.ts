import { describe, it, expect } from 'vitest';
import { isHelixRelevant } from './logFilter';

describe('isHelixRelevant', () => {
  it('matches Helix export-path keywords case-insensitively', () => {
    expect(isHelixRelevant('Exporting failed for otlphttp/bmchelix')).toBe(true);
    expect(isHelixRelevant('RESPONSE: 401 Unauthorized')).toBe(true);
    expect(isHelixRelevant('sending queue is full')).toBe(true);
  });

  it('rejects unrelated app log lines', () => {
    expect(isHelixRelevant('GET /healthz 200 OK')).toBe(false);
    expect(isHelixRelevant('user logged in')).toBe(false);
    expect(isHelixRelevant('')).toBe(false);
  });
});
