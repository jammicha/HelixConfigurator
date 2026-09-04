// Facade over the active connection in the connections store. GET/POST
// /api/env keep the same bare-key JSON shape single-tenant callers have
// always used; under the hood the store owns the data and its projection
// into .env (namespaced per-connection keys plus the active connection
// mirrored into these bare keys).
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

async function readEnvContent(envPath) {
  try {
    return await fs.readFile(envPath, 'utf8');
  } catch (e) {
    // Fresh native installs ship without a .env - treat as empty and create on
    // first POST (matches auth.js / envFile.js ENOENT handling).
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function parseManagedEnv(envContent) {
  const vars = {};
  envContent.split('\n').forEach((line) => {
    const [key, ...value] = line.split('=');
    if (key && value.length) {
      vars[key.trim()] = value.join('=').trim();
    }
  });
  return {
    HELIX_ENDPOINT: vars.HELIX_ENDPOINT || '',
    HELIX_API_KEY: vars.HELIX_API_KEY || '',
    X_SOURCE: vars.X_SOURCE || '',
    BUSINESS_SERVICE_KEY: vars.BUSINESS_SERVICE_KEY || '',
    HELIX_EVENTS_ENDPOINT: vars.HELIX_EVENTS_ENDPOINT || '',
  };
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

// Only `store` is needed here: it already knows envPath and owns every read
// and write against it. Callers pass `envPath` too (matching the other
// routes registered against the same store), it is simply unused by this
// route since the store fully encapsulates the file.
function register(app, { store }) {
  app.get('/api/env', async (req, res) => {
    try {
      const state = await store.getState();
      const active = state.connections.find((c) => c.id === state.activeId) || null;
      res.json({
        HELIX_ENDPOINT: active ? active.endpoint : '',
        HELIX_API_KEY: active ? await store.apiKeyFor(active.id) : '',
        X_SOURCE: active ? active.xSource : '',
        BUSINESS_SERVICE_KEY: active ? active.businessServiceKey : '',
        HELIX_EVENTS_ENDPOINT: active ? active.eventsEndpoint : '',
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read .env file' });
    }
  });

  app.post('/api/env', async (req, res) => {
    const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, BUSINESS_SERVICE_KEY, HELIX_EVENTS_ENDPOINT } = req.body;
    const patch = {
      endpoint: trim(HELIX_ENDPOINT),
      apiKey: trim(HELIX_API_KEY),
      xSource: trim(X_SOURCE),
      businessServiceKey: trim(BUSINESS_SERVICE_KEY),
      eventsEndpoint: trim(HELIX_EVENTS_ENDPOINT),
    };
    try {
      const state = await store.getState();
      const active = state.connections.find((c) => c.id === state.activeId) || null;
      if (active) {
        await store.update(active.id, patch);
      } else {
        await store.create({ name: patch.xSource || 'Default Connection', ...patch });
      }
      res.json({ message: 'Environment variables updated and reloaded' });
    } catch (e) {
      if (e.name === 'ValidationError') return res.status(400).json({ errors: e.errors });
      res.status(500).json({ error: 'Failed to update .env file' });
    }
  });
}

module.exports = { register, readEnvContent, parseManagedEnv, DEFAULT_ENV_PATH };
