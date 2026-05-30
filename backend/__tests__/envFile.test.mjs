import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { upsertEnvVar } = require('../envFile');

describe('upsertEnvVar', () => {
  let file;
  beforeEach(() => { file = path.join(os.tmpdir(), `env-test-${process.pid}-${Math.floor(performance.now())}`); });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  it('replaces an existing line, preserving the rest verbatim', () => {
    fs.writeFileSync(file, 'A=1\nBUSINESS_SERVICE_KEY=old\nB=2\n');
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nBUSINESS_SERVICE_KEY=new\nB=2\n');
  });
  it('appends when the key is absent', () => {
    fs.writeFileSync(file, 'A=1\n');
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'k');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nBUSINESS_SERVICE_KEY=k');
  });
  it('creates the file when missing', () => {
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'k');
    expect(fs.readFileSync(file, 'utf8')).toBe('BUSINESS_SERVICE_KEY=k');
  });
});
