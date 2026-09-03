import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConnectionsStore } = require('../connectionsStore.js');

let dir, connectionsPath, envPath;
const readEnv = () => (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '');
const envVal = (k) => {
  const line = readEnv().split('\n').find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1) : undefined;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-store-'));
  connectionsPath = path.join(dir, 'connections.json');
  envPath = path.join(dir, '.env');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const valid = { name: 'ACME Prod', endpoint: 'https://acme.onbmc.com', apiKey: 'T::A::S', xSource: 'acme-payments' };

describe('migration', () => {
  it('synthesizes a default connection from a populated single-tenant .env', async () => {
    fs.writeFileSync(envPath, 'HELIX_ENDPOINT=https://old.onbmc.com\nHELIX_API_KEY=O::A::S\nX_SOURCE=legacy\n');
    const store = createConnectionsStore({ connectionsPath, envPath });
    const state = await store.load();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0].id).toBe('default');
    expect(state.connections[0].endpoint).toBe('https://old.onbmc.com');
    expect(state.activeId).toBe('default');
    expect(await store.apiKeyFor('default')).toBe('O::A::S');
  });
  it('starts empty when .env has no endpoint', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    const state = await store.load();
    expect(state.connections).toEqual([]);
    expect(state.activeId).toBe(null);
  });
});

describe('create', () => {
  it('first connection becomes active and writes namespaced + mirror env keys', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    const { connection } = await store.create(valid);
    expect(connection.id).toBe('acme-prod');
    const state = await store.load();
    expect(state.activeId).toBe('acme-prod');
    expect(envVal('HELIX_API_KEY_ACME_PROD')).toBe('T::A::S');
    expect(envVal('HELIX_ENDPOINT_ACME_PROD')).toBe('https://acme.onbmc.com');
    expect(envVal('X_SOURCE_ACME_PROD')).toBe('acme-payments');
    expect(envVal('HELIX_API_KEY')).toBe('T::A::S');
    expect(envVal('HELIX_ENDPOINT')).toBe('https://acme.onbmc.com');
  });
  it('assigns a unique slug on name collision', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await store.create(valid);
    const { connection } = await store.create({ ...valid, apiKey: 'T2::A::S' });
    expect(connection.id).toBe('acme-prod-2');
  });
  it('throws ValidationError on bad input', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await expect(store.create({ ...valid, endpoint: 'nope' })).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('update', () => {
  it('keeps the slug when the name changes and preserves the api key when omitted', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await store.create(valid);
    await store.update('acme-prod', { name: 'Renamed', endpoint: 'https://acme.onbmc.com', xSource: 'acme-payments', signals: { traces: true, metrics: true, logs: true } });
    const state = await store.load();
    expect(state.connections[0].id).toBe('acme-prod');
    expect(state.connections[0].name).toBe('Renamed');
    expect(await store.apiKeyFor('acme-prod')).toBe('T::A::S');
  });
});

describe('remove', () => {
  it('prunes namespaced keys and promotes a new active connection', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await store.create(valid);
    await store.create({ ...valid, name: 'Beta', apiKey: 'B::A::S' });
    await store.remove(['acme-prod']);
    const state = await store.load();
    expect(state.connections.map((c) => c.id)).toEqual(['beta']);
    expect(state.activeId).toBe('beta');
    expect(envVal('HELIX_API_KEY_ACME_PROD')).toBeUndefined();
    expect(envVal('HELIX_API_KEY')).toBe('B::A::S');
  });
});

describe('remove', () => {
  it('leaves activeId null when removing the active connection and every survivor is disabled', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await store.create(valid);
    await store.create({ ...valid, name: 'Beta', apiKey: 'B::A::S' });
    await store.update('beta', { name: 'Beta', endpoint: valid.endpoint, xSource: valid.xSource, enabled: false, signals: { traces: true, metrics: true, logs: true } });
    await store.remove(['acme-prod']);
    const state = await store.load();
    expect(state.connections.map((c) => c.id)).toEqual(['beta']);
    expect(state.activeId).toBe(null);
    expect(envVal('HELIX_API_KEY')).toBe('');
    expect(envVal('HELIX_ENDPOINT')).toBe('');
  });
});

describe('setActive', () => {
  it('refuses a disabled connection', async () => {
    const store = createConnectionsStore({ connectionsPath, envPath });
    await store.create(valid);
    await store.create({ ...valid, name: 'Beta', apiKey: 'B::A::S' });
    await store.update('beta', { name: 'Beta', endpoint: valid.endpoint, xSource: valid.xSource, enabled: false, signals: { traces: true, metrics: true, logs: true } });
    await expect(store.setActive('beta')).rejects.toThrow();
  });
});
