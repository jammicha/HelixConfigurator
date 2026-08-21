import { describe, it, expect } from 'vitest';
import { viewerCandidates, preferredViewerEndpoint, CONTAINER_ENDPOINT } from '../viewerEndpoint.js';

describe('viewerCandidates', () => {
  it('defaults to host.docker.internal on the default port', () => {
    expect(viewerCandidates({ env: {} })).toEqual(['http://host.docker.internal:8765']);
  });

  it('honours a PORT override so a relocated UI still receives fan-out', () => {
    expect(viewerCandidates({ env: { PORT: '9100' } }))
      .toEqual(['http://host.docker.internal:9100']);
  });

  it('appends the bridge gateway IP as a fallback when one is known', () => {
    expect(viewerCandidates({ env: {}, bridgeIp: '172.18.0.1' })).toEqual([
      'http://host.docker.internal:8765',
      'http://172.18.0.1:8765',
    ]);
  });

  it('uses the compose service name when the configurator is containerized', () => {
    expect(viewerCandidates({ env: { PORT: '3001' }, containerized: true }))
      .toEqual([CONTAINER_ENDPOINT]);
  });

  it('ignores a bridge IP in the containerized path', () => {
    expect(viewerCandidates({ env: {}, containerized: true, bridgeIp: '172.18.0.1' }))
      .toEqual([CONTAINER_ENDPOINT]);
  });

  it('preferredViewerEndpoint returns the first candidate', () => {
    expect(preferredViewerEndpoint({ env: {}, bridgeIp: '172.18.0.1' }))
      .toBe('http://host.docker.internal:8765');
  });
});
