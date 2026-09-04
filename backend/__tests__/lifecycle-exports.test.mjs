import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lifecycle = require('../routes/lifecycle.js');

describe('lifecycle module exports', () => {
  it('exposes recreateGateway and readEnvAsArray for reuse by the connections route', () => {
    expect(typeof lifecycle.recreateGateway).toBe('function');
    expect(typeof lifecycle.readEnvAsArray).toBe('function');
  });
});
