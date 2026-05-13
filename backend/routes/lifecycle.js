// Gateway lifecycle: start / stop / restart the configured target container,
// plus network bridge orchestration (auto-bridge to APP_URL's container,
// manual attach to an arbitrary network, restart an arbitrary OTel
// collector). One status read-side route, six write-side.
//
// Auth: all gated by the /api/* requireAuth middleware in index.js.

const fs = require('fs');
const path = require('path');

const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Read .env into a KEY=VALUE array suitable for createContainer's Env. Skips
// blank lines and # comments. Tolerant of `KEY=value=with=equals` (splits on
// the first =). Returns null on read failure so the caller can fall back to
// the inspected container's existing Env rather than wiping it.
const readEnvAsArray = () => {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => {
        const idx = l.indexOf('=');
        return `${l.slice(0, idx).trim()}=${l.slice(idx + 1).trim()}`;
      });
  } catch {
    return null;
  }
};

// Stop + remove + recreate the gateway container, preserving its image,
// HostConfig (binds, ports, restart policy, network mode), labels, and
// network memberships — only the Env is refreshed from .env on disk.
//
// Why this instead of a plain restart: docker-compose evaluates `env_file`
// at container CREATE time, NOT at restart. A `docker restart` reuses the
// existing container's environment frozen at first `docker compose up`. So
// editing HELIX_ENDPOINT in the UI saved the new value to disk but the
// gateway kept shipping to the placeholder https://your-tenant.onbmc.com
// until the container was recreated. Now this endpoint does that recreate.
const recreateGateway = async (docker, name) => {
  const old = docker.getContainer(name);
  const inspect = await old.inspect();

  const freshEnv = readEnvAsArray();
  const envArray = freshEnv && freshEnv.length > 0 ? freshEnv : (inspect.Config?.Env || []);
  const allNetworks = Object.keys(inspect.NetworkSettings?.Networks || {});

  // Generous stop timeout so the exporter has a chance to flush its sending
  // queue. Tolerate 304 ("already stopped") and 404 (already gone).
  try { await old.stop({ t: 10 }); } catch (e) {
    if (e.statusCode !== 304 && e.statusCode !== 404) {
      console.warn(`recreateGateway: stop ${name} warning:`, e.message);
    }
  }
  try { await old.remove(); } catch (e) {
    if (e.statusCode !== 404) throw e;
  }

  const fresh = await docker.createContainer({
    name,
    Image: inspect.Config?.Image,
    Cmd: inspect.Config?.Cmd,
    Entrypoint: inspect.Config?.Entrypoint,
    Env: envArray,
    Labels: inspect.Config?.Labels,
    ExposedPorts: inspect.Config?.ExposedPorts,
    HostConfig: inspect.HostConfig,
  });
  await fresh.start();

  // Reattach to any additional networks the original was on. The primary
  // network is already attached via HostConfig.NetworkMode at create; extras
  // (e.g. a customer compose network the user bridged in Step 3) need an
  // explicit connect. 403 = already attached, fine.
  for (const net of allNetworks) {
    try {
      await docker.getNetwork(net).connect({ Container: name });
    } catch (e) {
      if (e.statusCode !== 403) {
        console.warn(`recreateGateway: reattach ${name} to ${net} warning:`, e.message);
      }
    }
  }
};

function register(app, { docker }) {
  // POST restart the configured target container. Recreates rather than
  // plain-restarts so updated .env values load (see recreateGateway above
  // for the env_file-at-create-time rationale).
  app.post('/api/lifecycle/restart', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      await recreateGateway(docker, targetContainer);
      res.json({ message: `Container ${targetContainer} restarted successfully` });
    } catch (e) {
      res.status(500).json({ error: 'Failed to restart container', details: e.message });
    }
  });

  // POST start collector.
  app.post('/api/lifecycle/start', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      await docker.getContainer(targetContainer).start();
      res.json({ message: `Container ${targetContainer} started successfully` });
    } catch (e) {
      // Already-running is a 304 from the API — treat as success.
      if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already running` });
      res.status(500).json({ error: 'Failed to start container', details: e.message });
    }
  });

  // POST stop collector.
  app.post('/api/lifecycle/stop', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      await docker.getContainer(targetContainer).stop();
      res.json({ message: `Container ${targetContainer} stopped successfully` });
    } catch (e) {
      if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already stopped` });
      res.status(500).json({ error: 'Failed to stop container', details: e.message });
    }
  });

  // POST bridge sidecar to target application network.
  app.post('/api/lifecycle/bridge', async (req, res) => {
    const { APP_URL } = req.body;
    const sidecarName = TARGET_CONTAINER();

    // APP_URL is optional. If the user didn't provide one, ensure the bridge
    // network exists but skip the auto-attach — they can use Discovered Services
    // to attach a container manually later.
    if (!APP_URL || !APP_URL.trim()) {
      try {
        await docker.createNetwork({ Name: 'helix-bridge' });
      } catch (e) { if (e.statusCode !== 409) console.warn('Network create warning:', e.message); }
      return res.json({ skipped: true, reason: 'No APP_URL provided — attach a container manually from Discovered Services.' });
    }

    // Ensure the shared network exists (idempotent).
    try {
      await docker.createNetwork({ Name: 'helix-bridge' });
    } catch (e) {
      // 409 means it already exists — fine.
      if (e.statusCode !== 409) {
        // Other errors: log but don't fail; the network may already be in use.
        console.warn('Network create warning:', e.message);
      }
    }

    // Derive target hostname from APP_URL. localhost / 127.0.0.1 / IPs can't be
    // resolved to a container, so treat them as "skipped" rather than failed —
    // the user keeps APP_URL for the dashboard deep-link, and uses the Step 2
    // network controls to attach helix-gateway instead.
    let parsedHost = '';
    try { parsedHost = new URL(APP_URL).hostname || ''; } catch { /* ignore */ }
    const looksLikeIp = /^[\d.]+$/.test(parsedHost);
    const isLoopback = parsedHost === 'localhost' || parsedHost === '127.0.0.1' || parsedHost === '::1';
    if (!parsedHost || isLoopback || looksLikeIp) {
      return res.json({
        skipped: true,
        reason: isLoopback
          ? `APP_URL "${APP_URL}" points at the host (not a Docker container) — auto-bridge can't infer a network from it.`
          : `APP_URL "${APP_URL}" is not a Docker container hostname — auto-bridge skipped.`,
      });
    }
    const targetHost = /^[a-zA-Z0-9.-]+$/.test(parsedHost) ? parsedHost : '';

    // Find a container whose name matches the target hostname.
    let containers;
    try {
      containers = await docker.listContainers();
    } catch (e) {
      return res.status(500).json({ error: 'Failed to list containers', details: e.message });
    }

    const target = targetHost
      ? containers.find(c => {
          const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
          return name.includes(targetHost);
        })
      : null;

    if (!target) {
      return res.status(404).json({ error: `No running container matches hostname "${targetHost}"` });
    }
    const targetName = (target.Names && target.Names[0] && target.Names[0].replace(/^\//, '')) || '';

    // Pick the most specific user network. Object.keys is non-deterministic across
    // Docker daemon versions, so explicitly skip system networks and prefer a
    // user-defined bridge (which is what compose creates).
    const targetNetworks = Object.keys((target.NetworkSettings && target.NetworkSettings.Networks) || {});
    const SYSTEM_NETWORKS = new Set(['host', 'none', 'ingress', 'helix-bridge']);
    const candidates = targetNetworks.filter(n => !SYSTEM_NETWORKS.has(n));
    if (candidates.length === 0) {
      return res.status(500).json({
        error: 'Target container has no user network to bridge to',
        details: `Available: ${targetNetworks.join(', ') || '(none)'}`,
      });
    }

    // Inspect each candidate; prefer driver=bridge, then by name length (more
    // specific wins over a generic "default" network).
    const inspected = await Promise.all(candidates.map(async name => {
      try {
        const info = await docker.getNetwork(name).inspect();
        return { name, driver: info.Driver || '' };
      } catch { return { name, driver: '' }; }
    }));
    inspected.sort((a, b) => {
      if (a.driver === 'bridge' && b.driver !== 'bridge') return -1;
      if (b.driver === 'bridge' && a.driver !== 'bridge') return 1;
      return b.name.length - a.name.length;
    });
    const picked = inspected[0].name;

    try {
      await docker.getNetwork(picked).connect({ Container: sidecarName });
      res.json({
        message: `Successfully bridged ${sidecarName} to network: ${picked}`,
        network: picked,
        candidates: inspected.map(i => i.name),
        targetContainer: targetName,
      });
    } catch (e) {
      if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
        return res.json({
          message: `${sidecarName} already attached to ${picked}`,
          network: picked,
          candidates: inspected.map(i => i.name),
          targetContainer: targetName,
        });
      }
      res.status(500).json({ error: 'Failed to bridge networks', details: e.message });
    }
  });

  // POST attach the sidecar to an arbitrary Docker network by name. Used by
  // the "Detected collectors" widget in Step 2 — one click to make
  // helix-gateway reachable from a collector that lives on a different
  // compose network. Idempotent; 403/"already exists" returns success.
  app.post('/api/lifecycle/bridge-network', async (req, res) => {
    const { network } = req.body || {};
    const sidecarName = TARGET_CONTAINER();
    if (!network || typeof network !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(network)) {
      return res.status(400).json({ error: 'Invalid network name' });
    }
    if (['host', 'none', 'ingress', 'helix-bridge'].includes(network)) {
      return res.status(400).json({ error: `Refusing to bridge to system network "${network}"` });
    }
    try {
      await docker.getNetwork(network).connect({ Container: sidecarName });
      res.json({ message: `Attached ${sidecarName} to ${network}`, network });
    } catch (e) {
      if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
        return res.json({ message: `${sidecarName} already attached to ${network}`, network });
      }
      if (e.statusCode === 404) {
        return res.status(404).json({ error: `Network "${network}" not found` });
      }
      res.status(500).json({ error: 'Failed to attach network', details: e.message });
    }
  });

  // POST restart an OTel collector container by name. Used by the "stream
  // stalled" affordance on /otel-data when the upstream collector's
  // memory_limiter has tripped (common after the OTel demo runs for hours).
  // Safety: the target must show up in /api/discovery/collectors — we won't
  // restart arbitrary infra by name.
  app.post('/api/lifecycle/restart-container', async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    try {
      const containers = await docker.listContainers();
      const isCollector = containers.some(c => {
        const cName = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
        if (cName !== name) return false;
        const image = c.Image || '';
        const command = c.Command || '';
        return /opentelemetry-collector/i.test(image) || /otelcol/i.test(image) || /otelcol/i.test(command);
      });
      if (!isCollector) {
        return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
      }
      await docker.getContainer(name).restart();
      res.json({ message: `Restarted ${name}`, name });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ error: `Container "${name}" not found` });
      }
      res.status(500).json({ error: 'Failed to restart container', details: e.message });
    }
  });

  // GET status of the collector container.
  app.get('/api/lifecycle/status', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      const data = await docker.getContainer(targetContainer).inspect();
      res.json({ status: (data.State && data.State.Status) || 'unknown' });
    } catch (e) {
      res.json({ status: 'error', error: e.message });
    }
  });
}

module.exports = { register };
