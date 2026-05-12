// Read / write the .env file that holds the Helix tenant credentials. The
// configurator-managed values are the only ones surfaced — other env vars
// in the file are preserved as-is on write.
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

function register(app) {
  app.get('/api/env', (req, res) => {
    try {
      const envContent = fs.readFileSync(ENV_PATH, 'utf8');
      const vars = {};
      envContent.split('\n').forEach(line => {
        const [key, ...value] = line.split('=');
        if (key && value) {
          vars[key.trim()] = value.join('=').trim();
        }
      });

      res.json({
        HELIX_ENDPOINT: vars.HELIX_ENDPOINT || '',
        HELIX_API_KEY: vars.HELIX_API_KEY || '',
        X_SOURCE: vars.X_SOURCE || '',
        APP_URL: vars.APP_URL || '',
        BUSINESS_SERVICE_KEY: vars.BUSINESS_SERVICE_KEY || '',
        HELIX_EVENTS_ENDPOINT: vars.HELIX_EVENTS_ENDPOINT || ''
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read .env file' });
    }
  });

  app.post('/api/env', (req, res) => {
    const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, APP_URL, BUSINESS_SERVICE_KEY, HELIX_EVENTS_ENDPOINT } = req.body;
    try {
      let envContent = fs.readFileSync(ENV_PATH, 'utf8');

      // Trim values so trailing whitespace from copy/paste doesn't propagate.
      const trim = (v) => (typeof v === 'string' ? v.trim() : '');
      const updates = {
        HELIX_ENDPOINT: trim(HELIX_ENDPOINT),
        HELIX_API_KEY: trim(HELIX_API_KEY),
        X_SOURCE: trim(X_SOURCE),
        APP_URL: trim(APP_URL),
        BUSINESS_SERVICE_KEY: trim(BUSINESS_SERVICE_KEY),
        HELIX_EVENTS_ENDPOINT: trim(HELIX_EVENTS_ENDPOINT),
      };

      let lines = envContent.split('\n');
      Object.keys(updates).forEach(key => {
        let found = false;
        lines = lines.map(line => {
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
      fs.writeFileSync(ENV_PATH, newContent, 'utf8');

      // Reload into process.env so subsequent same-process reads see fresh
      // values. The collector container picks up the new values from .env via
      // docker-compose's env_file mapping on the next restart; the caller is
      // expected to follow this POST with /api/lifecycle/restart.
      process.env.HELIX_ENDPOINT = HELIX_ENDPOINT;
      process.env.HELIX_API_KEY = HELIX_API_KEY;
      process.env.X_SOURCE = X_SOURCE;
      process.env.APP_URL = APP_URL;
      process.env.BUSINESS_SERVICE_KEY = BUSINESS_SERVICE_KEY || '';
      process.env.HELIX_EVENTS_ENDPOINT = HELIX_EVENTS_ENDPOINT || '';

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

module.exports = { register };
