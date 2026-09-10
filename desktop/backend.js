// desktop/backend.js
const { utilityProcess } = require('electron');
const getPort = require('get-port');
const { backendEntry, templatesDir, stateDir } = require('./paths');

async function pickPort() {
  return getPort();
}

async function waitForHealth(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 300;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetchImpl(`${baseUrl}/api/health`);
      const body = await res.json();
      if (body && body.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) throw new Error(`Backend health check timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function startBackend({ freePort } = {}) {
  const port = freePort ?? (await pickPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const path = require('path');
  const state = stateDir();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    HELIX_DATA_DIR: state,
    HELIX_ENV_PATH: path.join(state, '.env'),
    HELIX_CONFIG_PATH: path.join(state, 'helix-otel-collector.yaml'),
    HELIX_TEMPLATES_DIR: templatesDir(),
  };
  const child = utilityProcess.fork(backendEntry(), [], { env, stdio: 'pipe' });
  child.stdout?.on('data', (d) => console.log(`[backend] ${d}`.trimEnd()));
  child.stderr?.on('data', (d) => console.error(`[backend] ${d}`.trimEnd()));

  await waitForHealth(baseUrl);

  const stop = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); }
      setTimeout(finish, 6000);
    });

  return { port, baseUrl, child, stop };
}

module.exports = { pickPort, waitForHealth, startBackend };
