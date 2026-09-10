import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import statePaths from './statePaths.js';

const { resolveDataDir, resolveEnvPath, resolveConfigPath, ensureConfigSeeded } = statePaths;

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

describe('ensureConfigSeeded', () => {
  let root;
  const backendDir = () => path.join(root, 'backend');
  const base = () => path.join(root, 'helix-otel-collector.yaml');

  const setup = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-seed-'));
    fs.mkdirSync(backendDir(), { recursive: true });
    fs.writeFileSync(base(), 'BASE_CONFIG_CONTENT\n');
  };

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('seeds a missing target from the base config', () => {
    setup();
    const target = path.join(root, 'state', 'helix-otel-collector.yaml');
    ensureConfigSeeded({ backendDir: backendDir(), configPath: target });
    expect(fs.statSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('BASE_CONFIG_CONTENT\n');
  });

  it('does not overwrite an existing config file', () => {
    setup();
    const target = path.join(root, 'state', 'helix-otel-collector.yaml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'USER_EDITED\n');
    ensureConfigSeeded({ backendDir: backendDir(), configPath: target });
    expect(fs.readFileSync(target, 'utf8')).toBe('USER_EDITED\n');
  });

  it('repairs a Docker-auto-created directory at the target', () => {
    setup();
    const target = path.join(root, 'state', 'helix-otel-collector.yaml');
    fs.mkdirSync(target, { recursive: true });
    expect(fs.statSync(target).isDirectory()).toBe(true);
    ensureConfigSeeded({ backendDir: backendDir(), configPath: target });
    expect(fs.statSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('BASE_CONFIG_CONTENT\n');
  });

  it('is a no-op when the target is the base config itself (native install)', () => {
    setup();
    ensureConfigSeeded({ backendDir: backendDir(), configPath: base() });
    expect(fs.readFileSync(base(), 'utf8')).toBe('BASE_CONFIG_CONTENT\n');
  });
});
