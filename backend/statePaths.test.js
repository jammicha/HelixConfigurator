import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import statePaths from './statePaths.js';

const { resolveDataDir, resolveEnvPath, resolveConfigPath } = statePaths;

const BACKEND_DIR = '/opt/app/backend';

afterEach(() => {
  delete process.env.HELIX_DATA_DIR;
  delete process.env.HELIX_ENV_PATH;
  delete process.env.HELIX_CONFIG_PATH;
});

describe('statePaths', () => {
  it('prefers HELIX_DATA_DIR when set', () => {
    process.env.HELIX_DATA_DIR = '/user/data';
    expect(resolveDataDir({ appDirExists: false, backendDir: BACKEND_DIR })).toBe('/user/data');
  });

  it('falls back to container path, then sibling data dir', () => {
    expect(resolveDataDir({ appDirExists: true, backendDir: BACKEND_DIR })).toBe('/app/data');
    expect(resolveDataDir({ appDirExists: false, backendDir: BACKEND_DIR }))
      .toBe(path.join('/opt/app', 'data'));
  });

  it('resolves env path with and without override', () => {
    expect(resolveEnvPath({ backendDir: BACKEND_DIR })).toBe(path.join('/opt/app', '.env'));
    process.env.HELIX_ENV_PATH = '/user/.env';
    expect(resolveEnvPath({ backendDir: BACKEND_DIR })).toBe('/user/.env');
  });

  it('resolves config path with and without override', () => {
    expect(resolveConfigPath({ backendDir: BACKEND_DIR }))
      .toBe(path.join('/opt/app', 'helix-otel-collector.yaml'));
    process.env.HELIX_CONFIG_PATH = '/user/collector.yaml';
    expect(resolveConfigPath({ backendDir: BACKEND_DIR })).toBe('/user/collector.yaml');
  });
});
