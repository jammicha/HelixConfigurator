// Read / write the .env file that holds the Helix tenant credentials. The
// configurator-managed values are the only ones surfaced — other env vars
// in the file are preserved as-is on write.
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Serializes POST handlers so concurrent saves can't interleave their
// read-modify-write and lose updates. Sync I/O previously gave this for
// free via event-loop blocking; with async fs we need an explicit chain.
let envWriteChain = Promise.resolve();
const withEnvWriteLock = (fn) => {
  const next = envWriteChain.then(fn, fn);
  envWriteChain = next.catch(() => {});
  return next;
};

async function readEnvContent(envPath) {
  try {
    return await fs.readFile(envPath, 'utf8');
  } catch (e) {
    // Fresh native installs ship without a .env — treat as empty and create on
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

function register(app, { envPath = DEFAULT_ENV_PATH } = {}) {
  app.get('/api/env', async (req, res) => {
    try {
      const envContent = await readEnvContent(envPath);
      res.json(parseManagedEnv(envContent));
    } catch (e) {
      res.status(500).json({ error: 'Failed to read .env file' });
    }
  });

  app.post('/api/env', async (req, res) => {
    const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, BUSINESS_SERVICE_KEY, HELIX_EVENTS_ENDPOINT } = req.body;
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    const updates = {
      HELIX_ENDPOINT: trim(HELIX_ENDPOINT),
      HELIX_API_KEY: trim(HELIX_API_KEY),
      X_SOURCE: trim(X_SOURCE),
      BUSINESS_SERVICE_KEY: trim(BUSINESS_SERVICE_KEY),
      HELIX_EVENTS_ENDPOINT: trim(HELIX_EVENTS_ENDPOINT),
    };
    try {
      await withEnvWriteLock(async () => {
        const envContent = await readEnvContent(envPath);

        let lines = envContent.split('\n');
        Object.keys(updates).forEach((key) => {
          let found = false;
          lines = lines.map((line) => {
            if (line.startsWith(`${key}=`)) {
              found = true;
              return `${key}=${updates[key]}`;
            }
            return line;
          });
          // Only append when the user actually set a value. Empty values for keys
          // that aren't already in .env stay out of the file rather than creating
          // bare `KEY=` lines that confuse other env loaders.
          if (!found && updates[key]) {
            lines.push(`${key}=${updates[key]}`);
          }
        });

        const newContent = lines.join('\n');
        await fs.writeFile(envPath, newContent, 'utf8');
      });

      // Reload trimmed values into process.env so in-process reads match disk.
      process.env.HELIX_ENDPOINT = updates.HELIX_ENDPOINT;
      process.env.HELIX_API_KEY = updates.HELIX_API_KEY;
      process.env.X_SOURCE = updates.X_SOURCE;
      process.env.BUSINESS_SERVICE_KEY = updates.BUSINESS_SERVICE_KEY;
      process.env.HELIX_EVENTS_ENDPOINT = updates.HELIX_EVENTS_ENDPOINT;

      // Intentionally NOT rewriting helix-otel-collector.yaml here. The shipped
      // YAML references ${env:HELIX_ENDPOINT} / ${env:HELIX_API_KEY} /
      // ${env:X_SOURCE}, so the collector substitutes these from its own
      // environment at startup. Inlining the literal values into the YAML
      // (previous behavior) leaked the API key onto disk in a committed file
      // and made `${env:...}` substitution stop working for subsequent edits.

      res.json({ message: 'Environment variables updated and reloaded' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update .env file' });
    }
  });
}

module.exports = { register, readEnvContent, parseManagedEnv, DEFAULT_ENV_PATH };
