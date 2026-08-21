import { describe, it, expect } from 'vitest';
import { resolvePort, resolvePublishedPort } from '../portConfig.js';

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

describe('resolvePublishedPort', () => {
  it('native: the published port IS the port the process listens on', () => {
    expect(resolvePublishedPort({})).toBe(8765);
    expect(resolvePublishedPort({ PORT: '9100' })).toBe(9100);
  });

  it('containerized: PORT is the container-internal port, so the published port is the compose default', () => {
    // Dockerfile sets ENV PORT=3001; docker-compose publishes 8765:3001.
    expect(resolvePublishedPort({ PORT: '3001' }, { containerized: true })).toBe(8765);
  });

  it('VIEWER_PUBLISHED_PORT overrides both, for a remapped compose publish', () => {
    expect(resolvePublishedPort({ PORT: '3001', VIEWER_PUBLISHED_PORT: '9999' }, { containerized: true }))
      .toBe(9999);
    expect(resolvePublishedPort({ PORT: '9100', VIEWER_PUBLISHED_PORT: '9999' })).toBe(9999);
  });

  it('ignores a non-numeric VIEWER_PUBLISHED_PORT', () => {
    expect(resolvePublishedPort({ PORT: '3001', VIEWER_PUBLISHED_PORT: 'nope' }, { containerized: true }))
      .toBe(8765);
    expect(resolvePublishedPort({ PORT: '9100', VIEWER_PUBLISHED_PORT: 'nope' })).toBe(9100);
  });
});
