import { describe, it, expect } from 'vitest';
import { formatInstallLabel } from './installLabel';

describe('formatInstallLabel', () => {
  it('names the native package, the case where self-update works', () => {
    expect(formatInstallLabel({ version: '1.4.0', mode: 'native' })).toBe('v1.4.0 · native package');
  });

  it('calls a Windows install a native package too, since the mode only reflects self-update support', () => {
    expect(formatInstallLabel({ version: '1.4.0', mode: 'windows' })).toBe('v1.4.0 · native package');
  });

  it('distinguishes the Docker image', () => {
    expect(formatInstallLabel({ version: '1.4.0', mode: 'docker' })).toBe('v1.4.0 · Docker image');
  });

  // The distinction that actually caused confusion: a repo checkout running
  // `node index.js` looks identical to the packaged app in the browser.
  it('distinguishes a source checkout', () => {
    expect(formatInstallLabel({ version: '1.4.0', mode: 'dev-checkout' })).toBe('v1.4.0 · source checkout');
  });

  it('shows the version alone rather than guessing at an unrecognised mode', () => {
    expect(formatInstallLabel({ version: '1.4.0', mode: 'unsupported-platform' })).toBe('v1.4.0');
    expect(formatInstallLabel({ version: '1.4.0', mode: 'something-new' })).toBe('v1.4.0');
    expect(formatInstallLabel({ version: '1.4.0', mode: null })).toBe('v1.4.0');
  });

  it('renders nothing at all until the version is known', () => {
    expect(formatInstallLabel({ version: null, mode: 'native' })).toBe('');
    expect(formatInstallLabel({ version: '', mode: 'native' })).toBe('');
  });
});
