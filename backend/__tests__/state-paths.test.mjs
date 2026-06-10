import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDataDir } from '../statePaths.js';

describe('resolveDataDir', () => {
  it('uses /app/data inside the container (when /app exists)', () => {
    // Literal, not resolved — the container mount point is exactly this.
    expect(resolveDataDir({ appDirExists: true, backendDir: '/x/backend' })).toBe('/app/data');
  });
  it('uses <installRoot>/data natively (package root is backend/..)', () => {
    // Compute the expectation with the platform's own path semantics: on the
    // Windows CI runner, resolving '/opt/helix/backend' yields
    // 'D:\\opt\\helix\\backend' — a POSIX string literal here failed the
    // first Windows test run ever (2026-06-10, gated v1.2.0 build).
    expect(resolveDataDir({ appDirExists: false, backendDir: '/opt/helix/backend' }))
      .toBe(path.join(path.resolve('/opt/helix/backend', '..'), 'data'));
  });
});
