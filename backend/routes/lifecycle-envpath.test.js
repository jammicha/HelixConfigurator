import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The desktop app relocates the projected .env via HELIX_ENV_PATH. The gateway
// container receives its endpoint and key env vars from readEnvAsArray(), so
// that reader MUST honor HELIX_ENV_PATH. Otherwise the collector starts with
// unset HELIX_ENDPOINT_* and aborts with "at least one endpoint must be
// specified", which is exactly the Docker-route connection failure this covers.
let readEnvAsArray;
let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-lifecycle-env-'));
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(
    envFile,
    'HELIX_ENDPOINT_DEFAULT=https://example.test\nHELIX_API_KEY_DEFAULT=secret-key\n',
  );
  process.env.HELIX_ENV_PATH = envFile;
  // Import AFTER setting the env so the module-level ENV_PATH resolves it.
  const mod = await import('./lifecycle.js');
  readEnvAsArray = (mod.default ?? mod).readEnvAsArray;
});

afterAll(() => {
  delete process.env.HELIX_ENV_PATH;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('lifecycle readEnvAsArray honors HELIX_ENV_PATH (desktop .env relocation)', () => {
  it('reads the relocated .env so the gateway container receives projected vars', async () => {
    const arr = await readEnvAsArray();
    expect(arr).toContain('HELIX_ENDPOINT_DEFAULT=https://example.test');
    expect(arr).toContain('HELIX_API_KEY_DEFAULT=secret-key');
  });
});
