import { describe, it, expect } from 'vitest';
import {
  slugify, ensureUniqueId, envSuffix, exporterName,
  validateConnection, normalizeConnection, MANAGED_PREFIX,
} from '../connectionModel.js';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('ACME Production!')).toBe('acme-production');
  });
  it('collapses runs and trims edge dashes', () => {
    expect(slugify('  --Foo   Bar-- ')).toBe('foo-bar');
  });
});

describe('ensureUniqueId', () => {
  it('returns base when free', () => {
    expect(ensureUniqueId('acme', ['other'])).toBe('acme');
  });
  it('suffixes on collision', () => {
    expect(ensureUniqueId('acme', ['acme', 'acme-2'])).toBe('acme-3');
  });
});

describe('envSuffix / exporterName', () => {
  it('uppercases and underscores the id', () => {
    expect(envSuffix('acme-prod')).toBe('ACME_PROD');
  });
  it('names the exporter off the raw id', () => {
    expect(exporterName('acme-prod')).toBe('otlphttp/bmchelix_acme-prod');
    expect(exporterName('acme-prod').startsWith(MANAGED_PREFIX)).toBe(true);
  });
});

describe('validateConnection', () => {
  const ok = { name: 'A', endpoint: 'https://t.onbmc.com', apiKey: 'T::A::S', xSource: 'svc', signals: { traces: true, metrics: false, logs: false } };
  it('accepts a valid connection', () => {
    expect(validateConnection(ok).valid).toBe(true);
  });
  it('rejects endpoint without https', () => {
    expect(validateConnection({ ...ok, endpoint: 'ftp://x' }).errors.endpoint).toBeTruthy();
  });
  it('rejects endpoint containing /otlp', () => {
    expect(validateConnection({ ...ok, endpoint: 'https://t.onbmc.com/otlp' }).errors.endpoint).toBeTruthy();
  });
  it('rejects api key that is not three :: parts', () => {
    expect(validateConnection({ ...ok, apiKey: 'T::A' }).errors.apiKey).toBeTruthy();
  });
  it('rejects xSource with a leading space', () => {
    expect(validateConnection({ ...ok, xSource: ' svc' }).errors.xSource).toBeTruthy();
  });
  it('rejects a connection with no signals enabled', () => {
    expect(validateConnection({ ...ok, signals: { traces: false, metrics: false, logs: false } }).errors.signals).toBeTruthy();
  });
});

describe('normalizeConnection', () => {
  it('assigns id, defaults, and omits apiKey', () => {
    const c = normalizeConnection({ name: 'A', endpoint: 'https://t', xSource: 'svc', apiKey: 'x' }, { id: 'a' });
    expect(c).toEqual({
      id: 'a', name: 'A', endpoint: 'https://t', xSource: 'svc',
      businessServiceKey: '', eventsEndpoint: '',
      signals: { traces: true, metrics: true, logs: true }, enabled: true,
    });
    expect('apiKey' in c).toBe(false);
  });
});
