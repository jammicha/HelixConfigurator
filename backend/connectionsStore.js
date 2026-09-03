// Owns data/connections.json and its projection into .env. Structure lives in
// the JSON; secrets and collector-substituted values are projected into .env
// under per-connection namespaced keys, with the active connection mirrored
// into the bare HELIX_* keys so existing single-tenant consumers are unchanged.
const fs = require('fs').promises;
const {
  slugify, ensureUniqueId, envSuffix, validateConnection, normalizeConnection,
} = require('./connectionModel');

const WIZARD_MIRROR_KEYS = ['HELIX_ENDPOINT', 'HELIX_API_KEY', 'X_SOURCE', 'BUSINESS_SERVICE_KEY', 'HELIX_EVENTS_ENDPOINT'];

class ValidationError extends Error {
  constructor(errors) { super('Invalid connection'); this.name = 'ValidationError'; this.errors = errors; }
}

const readFileOrEmpty = async (p) => {
  try { return await fs.readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

const parseEnv = (text) => {
  const vars = {};
  text.split('\n').forEach((line) => {
    if (!line || line.startsWith('#')) return;
    const i = line.indexOf('=');
    if (i < 0) return;
    vars[line.slice(0, i).trim()] = line.slice(i + 1);
  });
  return vars;
};

// Rewrite .env so exactly `desired` (KEY->value) is present, pruning any key
// matched by ownedKey(k) that is not in desired. Other lines are preserved.
const rewriteEnv = (text, desired, ownedKey) => {
  const seen = new Set();
  const out = text.split('\n').map((line) => {
    const i = line.indexOf('=');
    if (i < 0 || line.startsWith('#')) return line;
    const key = line.slice(0, i).trim();
    if (Object.prototype.hasOwnProperty.call(desired, key)) { seen.add(key); return `${key}=${desired[key]}`; }
    if (ownedKey(key)) return null;
    return line;
  }).filter((l) => l !== null);
  for (const [key, value] of Object.entries(desired)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\n');
};

function createConnectionsStore({ connectionsPath, envPath }) {
  let writeChain = Promise.resolve();
  const withLock = (fn) => { const next = writeChain.then(fn, fn); writeChain = next.catch(() => {}); return next; };

  const isManagedNamespacedKey = (key) =>
    /^(HELIX_ENDPOINT|HELIX_API_KEY|X_SOURCE)_[A-Z0-9_]+$/.test(key);

  const persist = async (state, extraApiKeys = {}) => {
    await fs.writeFile(connectionsPath, JSON.stringify(state, null, 2), 'utf8');
    const envText = await readFileOrEmpty(envPath);
    const existing = parseEnv(envText);
    const desired = {};
    const active = state.connections.find((c) => c.id === state.activeId) || null;
    for (const c of state.connections) {
      const suf = envSuffix(c.id);
      desired[`HELIX_ENDPOINT_${suf}`] = c.endpoint;
      desired[`X_SOURCE_${suf}`] = c.xSource;
      const apiKeyKey = `HELIX_API_KEY_${suf}`;
      desired[apiKeyKey] = extraApiKeys[apiKeyKey] ?? existing[apiKeyKey] ?? '';
    }
    desired.HELIX_ENDPOINT = active ? active.endpoint : '';
    desired.X_SOURCE = active ? active.xSource : '';
    desired.BUSINESS_SERVICE_KEY = active ? active.businessServiceKey : '';
    desired.HELIX_EVENTS_ENDPOINT = active ? active.eventsEndpoint : '';
    desired.HELIX_API_KEY = active ? (desired[`HELIX_API_KEY_${envSuffix(active.id)}`] || '') : '';

    const ownedKey = (k) => isManagedNamespacedKey(k) || WIZARD_MIRROR_KEYS.includes(k);
    await fs.writeFile(envPath, rewriteEnv(envText, desired, ownedKey), 'utf8');
    for (const k of WIZARD_MIRROR_KEYS) process.env[k] = desired[k];
  };

  const readState = async () => {
    const raw = await readFileOrEmpty(connectionsPath);
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      return { version: 1, activeId: parsed.activeId ?? null, connections: parsed.connections || [] };
    }
    const env = parseEnv(await readFileOrEmpty(envPath));
    if ((env.HELIX_ENDPOINT || '').trim()) {
      const conn = normalizeConnection({
        name: env.X_SOURCE || 'Default Connection',
        endpoint: env.HELIX_ENDPOINT,
        xSource: env.X_SOURCE || '',
        businessServiceKey: env.BUSINESS_SERVICE_KEY || '',
        eventsEndpoint: env.HELIX_EVENTS_ENDPOINT || '',
      }, { id: 'default' });
      const state = { version: 1, activeId: 'default', connections: [conn] };
      await persist(state, { [`HELIX_API_KEY_${envSuffix('default')}`]: env.HELIX_API_KEY || '' });
      return state;
    }
    return { version: 1, activeId: null, connections: [] };
  };

  const apiKeyFor = async (id) => parseEnv(await readFileOrEmpty(envPath))[`HELIX_API_KEY_${envSuffix(id)}`] || '';

  return {
    WIZARD_MIRROR_KEYS,
    load: () => withLock(readState),
    getState: () => withLock(readState),
    apiKeyFor,
    projectToEnv: (state) => withLock(() => persist(state)),
    create: (input) => withLock(async () => {
      const state = await readState();
      const id = ensureUniqueId(slugify(input.name), state.connections.map((c) => c.id));
      const conn = normalizeConnection(input, { id });
      const check = validateConnection({ ...conn, apiKey: (input.apiKey || '').trim() });
      if (!check.valid) throw new ValidationError(check.errors);
      state.connections.push(conn);
      if (!state.activeId) state.activeId = id;
      await persist(state, { [`HELIX_API_KEY_${envSuffix(id)}`]: (input.apiKey || '').trim() });
      return { state, connection: conn };
    }),
    update: (id, patch) => withLock(async () => {
      const state = await readState();
      const conn = state.connections.find((c) => c.id === id);
      if (!conn) { const e = new Error('Not found'); e.code = 'NOT_FOUND'; throw e; }
      const merged = normalizeConnection({ ...conn, ...patch }, { id });
      const check = validateConnection({ ...merged, apiKey: (patch.apiKey || '').trim() || await apiKeyFor(id) });
      if (!check.valid) throw new ValidationError(check.errors);
      Object.assign(conn, merged);
      if (!conn.enabled && state.activeId === id) {
        const next = state.connections.find((c) => c.enabled && c.id !== id);
        if (!next) { const e = new Error('Cannot disable the only active connection'); e.code = 'INVARIANT'; throw e; }
        state.activeId = next.id;
      }
      const extra = {};
      if ((patch.apiKey || '').trim()) extra[`HELIX_API_KEY_${envSuffix(id)}`] = patch.apiKey.trim();
      await persist(state, extra);
      return state;
    }),
    remove: (ids) => withLock(async () => {
      const state = await readState();
      const drop = new Set(ids);
      state.connections = state.connections.filter((c) => !drop.has(c.id));
      if (drop.has(state.activeId)) {
        const next = state.connections.find((c) => c.enabled) || state.connections[0] || null;
        state.activeId = next ? next.id : null;
      }
      await persist(state);
      return state;
    }),
    setActive: (id) => withLock(async () => {
      const state = await readState();
      const conn = state.connections.find((c) => c.id === id);
      if (!conn) { const e = new Error('Not found'); e.code = 'NOT_FOUND'; throw e; }
      if (!conn.enabled) { const e = new Error('Cannot activate a disabled connection'); e.code = 'INVARIANT'; throw e; }
      state.activeId = id;
      await persist(state);
      return state;
    }),
  };
}

module.exports = { createConnectionsStore, ValidationError, WIZARD_MIRROR_KEYS };
