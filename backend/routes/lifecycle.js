// Gateway lifecycle: start / stop / restart the configured target container,
// plus network bridge orchestration (auto-bridge to APP_URL's container,
// manual attach to an arbitrary network, restart an arbitrary OTel
// collector). One status read-side route, six write-side.
//
// Auth: all gated by the /api/* requireAuth middleware in index.js.

const fs = require('fs');
const path = require('path');
const { withDockerTimeout, sendDockerTimeoutResponse } = require('../util');

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
const recreateGateway = async (docker, name, { addNetwork } = {}) => {
  const old = docker.getContainer(name);
  const inspect = await old.inspect();

  const freshEnv = readEnvAsArray();
  const envArray = freshEnv && freshEnv.length > 0 ? freshEnv : (inspect.Config?.Env || []);
  const allNetworks = new Set(Object.keys(inspect.NetworkSettings?.Networks || {}));
  if (addNetwork) allNetworks.add(addNetwork);

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

  // CRITICAL — attach extras BEFORE start, not after. A Docker network
  // attached after the container's process starts is invisible to any
  // sockets that already bound; the OTLP HTTP listener on 0.0.0.0:4318
  // only accepts on interfaces present at bind time. That's the
  // root cause of "gateway reachable by DNS on the customer's compose
  // network but TCP returns connection refused" reports.
  //
  // The primary network is already attached via HostConfig.NetworkMode at
  // create. We pre-attach every other inspected network here, in the
  // gap between createContainer and start.
  const primary = inspect.HostConfig?.NetworkMode || 'default';
  for (const net of allNetworks) {
    if (net === primary) continue;
    try {
      await docker.getNetwork(net).connect({ Container: name });
    } catch (e) {
      if (e.statusCode !== 403) {
        console.warn(`recreateGateway: pre-start connect ${name} to ${net} warning:`, e.message);
      }
    }
  }

  await fresh.start();
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
      await withDockerTimeout(docker.getContainer(targetContainer).start(), 'container.start');
      res.json({ message: `Container ${targetContainer} started successfully` });
    } catch (e) {
      // Already-running is a 304 from the API — treat as success.
      if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already running` });
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to start container', details: e.message });
    }
  });

  // POST stop collector.
  app.post('/api/lifecycle/stop', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      // Stop can legitimately take longer than 15s if the container is mid-flush;
      // give it 30s before declaring the daemon wedged.
      await withDockerTimeout(docker.getContainer(targetContainer).stop(), 'container.stop', 30_000);
      res.json({ message: `Container ${targetContainer} stopped successfully` });
    } catch (e) {
      if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already stopped` });
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to stop container', details: e.message });
    }
  });

  // POST bridge sidecar to target application network, AND recreate the
  // gateway so any updated .env values (saved by the preceding POST /api/env)
  // also load. This endpoint is the single "apply Step 1 changes" hook, so
  // the recreate happens regardless of whether APP_URL is set or resolvable.
  // Skipping the recreate when bridging was skipped would silently lose the
  // env update.
  app.post('/api/lifecycle/bridge', async (req, res) => {
    const { APP_URL } = req.body;
    const sidecarName = TARGET_CONTAINER();

    // Ensure the helix-bridge network exists (idempotent) so manual attach
    // from Discovered Services has somewhere to land.
    try {
      await docker.createNetwork({ Name: 'helix-bridge' });
    } catch (e) {
      if (e.statusCode !== 409) console.warn('Network create warning:', e.message);
    }

    // Decide whether APP_URL gives us an auto-bridge target. Null = skip the
    // attach but still recreate.
    let pickedNetwork = null;
    let targetName = null;
    let candidateNames = null;
    let skipReason = null;
    if (APP_URL && APP_URL.trim()) {
      let parsedHost = '';
      try { parsedHost = new URL(APP_URL).hostname || ''; } catch { /* ignore */ }
      const looksLikeIp = /^[\d.]+$/.test(parsedHost);
      const isLoopback = parsedHost === 'localhost' || parsedHost === '127.0.0.1' || parsedHost === '::1';
      const targetHost = parsedHost && /^[a-zA-Z0-9.-]+$/.test(parsedHost) ? parsedHost : '';
      if (!parsedHost || isLoopback || looksLikeIp || !targetHost) {
        skipReason = isLoopback
          ? `APP_URL "${APP_URL}" points at the host (not a Docker container) — auto-bridge can't infer a network from it.`
          : `APP_URL "${APP_URL}" is not a Docker container hostname — auto-bridge skipped.`;
      } else {
        let containers;
        try { containers = await withDockerTimeout(docker.listContainers(), 'docker.listContainers'); }
        catch (e) {
          if (sendDockerTimeoutResponse(res, e)) return;
          return res.status(500).json({ error: 'Failed to list containers', details: e.message });
        }
        // Exact-match on container name (or one of its declared aliases) —
        // see commit 4b4787a for why substring matching is a bug.
        const target = containers.find(c => {
          const names = (c.Names || []).map(n => n.replace(/^\//, ''));
          return names.includes(targetHost);
        });
        if (!target) {
          return res.status(404).json({ error: `No running container matches hostname "${targetHost}"` });
        }
        targetName = (target.Names || []).map(n => n.replace(/^\//, ''))[0] || '';
        const SYSTEM_NETWORKS = new Set(['host', 'none', 'ingress', 'helix-bridge']);
        const targetNetworks = Object.keys((target.NetworkSettings && target.NetworkSettings.Networks) || {});
        const candidates = targetNetworks.filter(n => !SYSTEM_NETWORKS.has(n));
        if (candidates.length === 0) {
          return res.status(500).json({
            error: 'Target container has no user network to bridge to',
            details: `Available: ${targetNetworks.join(', ') || '(none)'}`,
          });
        }
        // Prefer driver=bridge, then longer name (more specific over default).
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
        pickedNetwork = inspected[0].name;
        candidateNames = inspected.map(i => i.name);

        // Idempotent attach. 403 = already attached, fine.
        try {
          await docker.getNetwork(pickedNetwork).connect({ Container: sidecarName });
        } catch (e) {
          if (e.statusCode !== 403 && !/already exists/i.test(e.message || '')) {
            return res.status(500).json({ error: 'Failed to bridge networks', details: e.message });
          }
        }
      }
    } else {
      skipReason = 'No APP_URL provided — attach a container manually from Discovered Services.';
    }

    // Single recreate covers both: fresh .env values load, and the just-
    // attached network is present from t=0 so the OTLP listener accepts on
    // it. Previously the wizard called /api/lifecycle/restart THEN /api/
    // lifecycle/bridge, which did two recreates back-to-back (~10s of
    // unnecessary downtime). The frontend now calls only this endpoint.
    try {
      await recreateGateway(docker, sidecarName, pickedNetwork ? { addNetwork: pickedNetwork } : undefined);
    } catch (e) {
      return res.status(500).json({
        error: 'Gateway recreate failed — env changes and bridge attach may not have taken effect',
        details: e.message,
        network: pickedNetwork || undefined,
      });
    }

    if (pickedNetwork) {
      return res.json({
        message: `Successfully bridged ${sidecarName} to network: ${pickedNetwork}`,
        network: pickedNetwork,
        candidates: candidateNames,
        targetContainer: targetName,
      });
    }
    res.json({ skipped: true, reason: skipReason });
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
    // Idempotent attach + recreate. Same rationale as the auto-bridge route:
    // a runtime `docker network connect` adds the interface but doesn't
    // surface it to already-bound listening sockets, so the gateway has to
    // be recreated for the customer's collector to actually reach it.
    let alreadyAttached = false;
    try {
      await docker.getNetwork(network).connect({ Container: sidecarName });
    } catch (e) {
      if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
        alreadyAttached = true;
      } else if (e.statusCode === 404) {
        return res.status(404).json({ error: `Network "${network}" not found` });
      } else {
        return res.status(500).json({ error: 'Failed to attach network', details: e.message });
      }
    }
    try {
      await recreateGateway(docker, sidecarName, { addNetwork: network });
    } catch (e) {
      return res.status(500).json({
        error: 'Network attached but gateway recreate failed — telemetry may not flow until restart',
        details: e.message,
        network,
      });
    }
    res.json({
      message: alreadyAttached
        ? `${sidecarName} already attached to ${network} (rebuilt to refresh listener)`
        : `Attached ${sidecarName} to ${network}`,
      network,
    });
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
      const containers = await withDockerTimeout(docker.listContainers(), 'docker.listContainers');
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
      await withDockerTimeout(docker.getContainer(name).restart(), 'container.restart');
      res.json({ message: `Restarted ${name}`, name });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ error: `Container "${name}" not found` });
      }
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to restart container', details: e.message });
    }
  });

  // GET status of the collector container.
  app.get('/api/lifecycle/status', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      // Status check is meant to be fast — a slow inspect points at a wedged
      // daemon; surface that explicitly instead of letting the UI's status
      // poll hang for two minutes.
      const data = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
      res.json({ status: (data.State && data.State.Status) || 'unknown' });
    } catch (e) {
      res.json({ status: 'error', error: e.message });
    }
  });
}

module.exports = { register };
