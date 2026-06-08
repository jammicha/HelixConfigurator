import { describe, it, expect } from 'vitest';
import { resolveDataDir } from '../statePaths.js';

describe('resolveDataDir', () => {
  it('uses /app/data inside the container (when /app exists)', () => {
    expect(resolveDataDir({ appDirExists: true, backendDir: '/x/backend' })).toBe('/app/data');
  });
  it('uses <installRoot>/data natively (package root is backend/..)', () => {
    expect(resolveDataDir({ appDirExists: false, backendDir: '/opt/helix/backend' }))
      .toBe('/opt/helix/data');
  });
});
