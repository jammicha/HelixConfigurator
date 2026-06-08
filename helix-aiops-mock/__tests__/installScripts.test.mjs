// helix-aiops-mock/__tests__/installScripts.test.mjs
import { describe, it, expect } from 'vitest';
import { renderBashInstaller, renderPowerShellInstaller } from '../installScripts.js';

const session = { xSource: 'cart svc', apiKey: 'FAKE-KEY-AB', endpoint: 'https://t.onbmc.com' };
const repo = 'jammicha/HelixConfigurator';

describe('renderBashInstaller', () => {
  const sh = renderBashInstaller({ session, repo });
  it('detects platform and builds the latest/download URL', () => {
    expect(sh).toContain('releases/latest/download/helix-configurator-');
    expect(sh).toContain('github.com/jammicha/HelixConfigurator');
  });
  it('templates a sanitized X_SOURCE and the api key into .env', () => {
    expect(sh).toContain('X_SOURCE=cart-svc');           // spaces sanitized
    expect(sh).toContain('HELIX_API_KEY=FAKE-KEY-AB');
    expect(sh).toContain('HELIX_ENDPOINT=https://t.onbmc.com');
  });
  it('does NOT require docker', () => {
    expect(sh).not.toMatch(/docker (info|compose)/);
  });
  it('refuses Intel Macs (darwin-amd64) with a Docker pointer instead of a 404', () => {
    expect(sh).toContain('"$PLATFORM" = "darwin-amd64"');
    expect(sh).toMatch(/Intel Macs aren't supported/);
    expect(sh).toContain('ghcr.io/jammicha/helixconfigurator');
  });
});

describe('renderPowerShellInstaller', () => {
  const ps = renderPowerShellInstaller({ session, repo });
  it('maps arch to the windows-amd64 asset', () => {
    expect(ps).toContain('helix-configurator-windows-amd64.zip');
  });
  it('templates a sanitized X_SOURCE, api key, and endpoint into .env', () => {
    expect(ps).toContain('X_SOURCE=cart-svc');           // spaces sanitized
    expect(ps).toContain('HELIX_API_KEY=FAKE-KEY-AB');
    expect(ps).toContain('HELIX_ENDPOINT=https://t.onbmc.com');
  });
  it('uses a single-quoted here-string so .env values are not PS-expanded', () => {
    expect(ps).toContain("@'");
    expect(ps).toContain("'@ | Set-Content .env");
  });
});
