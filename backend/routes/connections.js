// CRUD + activate + test + health for multiple Helix connections. Structural
// writes go through the connections store; anything that must reach the
// collector is applied atomically (snapshot -> mutate -> rewrite yaml ->
// recreate gateway -> settle -> rollback on rejection). Activation is the one
// change that does not touch the collector, so it skips the recreate entirely.
const fs = require('fs').promises;
const axios = require('axios');
const { syncManagedExporters, verifyManagedYaml } = require('../collectorConnections');
const { ValidationError } = require('../connectionsStore');
const { waitForGatewaySettle, extractCollectorError } = require('./config');
const lifecycle = require('./lifecycle');
const { perExporterCounters, exporterVerdict } = require('./diagnostics');
const { exporterName } = require('../connectionModel');
const { resolveGatewayMetricsBase } = require('../util');

const TARGET = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

const parseEnv = (text) => {
  const vars = {};
  text.split('\n').forEach((line) => {
    if (!line || line.startsWith('#')) return;
    const i = line.indexOf('='); if (i < 0) return;
    vars[line.slice(0, i).trim()] = line.slice(i + 1);
  });
  return vars;
};

function register(app, { docker, containerLogs, configPath, connectionsPath, envPath, store, recreateGateway }) {
  const recreate = recreateGateway || ((d, name, opts) => lifecycle.recreateGateway(d, name, opts));
  const publicState = (state) => ({ activeId: state.activeId, connections: state.connections });

  const readOr = async (p) => fs.readFile(p, 'utf8').catch(() => '');
  const restore = async (snap) => {
    await fs.writeFile(connectionsPath, snap.json).catch(() => {});
    await fs.writeFile(envPath, snap.env).catch(() => {});
    await fs.writeFile(configPath, snap.yaml).catch(() => {});
  };

  async function writeManagedYaml(state) {
    const enabled = state.connections.filter((c) => c.enabled).map((c) => ({ id: c.id, signals: c.signals }));
    const before = await fs.readFile(configPath, 'utf8');
    const after = syncManagedExporters(before, enabled);
    const envVars = parseEnv(await readOr(envPath));
    verifyManagedYaml(after, enabled, envVars);
    await fs.writeFile(configPath, after, 'utf8');
  }

  // mutate() writes json+env via the store and returns the new state.
  async function applyAtomically(res, mutate) {
    const name = TARGET();
    const snap = { json: await readOr(connectionsPath), env: await readOr(envPath), yaml: await readOr(configPath) };

    let state;
    try {
      state = await mutate();
      await writeManagedYaml(state);
    } catch (e) {
      await restore(snap);
      if (e instanceof ValidationError) return res.status(400).json({ errors: e.errors });
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Connection not found' });
      if (e.code === 'INVARIANT') return res.status(409).json({ error: e.message });
      return res.status(500).json({ error: e.message });
    }

    try { await recreate(docker, name); }
    catch (e) { return res.status(500).json({ error: 'Gateway recreate failed', details: e.message, state: publicState(state) }); }

    const settled = await waitForGatewaySettle(docker, containerLogs, name);
    if (!settled.running) {
      await restore(snap);
      await recreate(docker, name).catch(() => {});
      return res.status(400).json({
        error: 'Collector rejected the change - rolled back',
        details: extractCollectorError(settled.recentLogs) || `Collector exited (code ${settled.exitCode})`,
        rolledBack: true,
      });
    }
    return res.json({ state: publicState(state) });
  }

  app.get('/api/connections', async (req, res) => {
    try { res.json(publicState(await store.getState())); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/connections', (req, res) => applyAtomically(res, async () => (await store.create(req.body)).state));
  app.put('/api/connections/:id', (req, res) => applyAtomically(res, () => store.update(req.params.id, req.body)));
  app.delete('/api/connections/:id', (req, res) => applyAtomically(res, () => store.remove([req.params.id])));

  app.post('/api/connections/:id/activate', async (req, res) => {
    try { const state = await store.setActive(req.params.id); res.json({ activeId: state.activeId }); }
    catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Connection not found' });
      if (e.code === 'INVARIANT') return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/connections/:id/test', async (req, res) => {
    try {
      const state = await store.getState();
      const conn = state.connections.find((c) => c.id === req.params.id);
      if (!conn) return res.status(404).json({ error: 'Connection not found' });
      const apiKey = await store.apiKeyFor(conn.id);
      const base = process.env.SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
      const r = await axios.post(`${base}/api/diagnostics/test-connection`, { endpoint: conn.endpoint, apiKey }, { timeout: 15000, validateStatus: () => true });
      res.status(r.status).json(r.data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
  });

  app.get('/api/connections/health', async (req, res) => {
    try {
      const r = await axios.get(`${resolveGatewayMetricsBase()}/metrics`, { timeout: 2000 });
      const byExp = perExporterCounters(r.data);
      const state = await store.getState();
      const out = {};
      for (const c of state.connections) {
        const counters = byExp[exporterName(c.id)] || { sent: 0, failed: 0 };
        out[c.id] = { ...counters, verdict: c.enabled ? exporterVerdict(counters) : 'disabled' };
      }
      res.json(out);
    } catch (e) { res.json({ error: e.message }); }
  });
}

module.exports = { register };
