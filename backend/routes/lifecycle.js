// Gateway lifecycle: start / stop / restart the configured target container,
// plus network bridge orchestration (auto-bridge to APP_URL's container,
// manual attach to an arbitrary network, restart an arbitrary OTel
// collector). One status read-side route, six write-side.
//
// Auth: all gated by the /api/* requireAuth middleware in index.js.

const fs = require('fs');
const path = require('path');
const { withDockerTimeout, sendDockerTimeoutResponse, detectCollectorContainers } = require('../util');
const { clearActiveRun: clearSyntheticRun } = require('./step-zero/synthetic');
const errorLog = require('../errorLog');

const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Persistent record of "networks the gateway should be attached to." Every
// `docker network connect` issued by the bridge routes also lands here. On
// configurator boot, we read this list and re-attach helix-gateway to any
// missing entries, so a `docker compose down && up` cycle (or a configurator
// restart) doesn't silently drop the gateway from the customer's network and
// leave the wizard in a half-bridged state.
//
// File lives in the same data/ volume as the OTel store so it survives
// container restarts. Single-writer assumption: only this process mutates it.
const BRIDGED_NETWORKS_PATH = (() => {
  // Mirror the OTEL_DB_PATH logic from index.js so the file lands in the same
  // volume both inside and outside the container.
  if (fs.existsSync('/app')) return '/app/data/bridged-networks.json';
  return path.join(__dirname, '..', 'data', 'bridged-networks.json');
})();

const loadBridgedNetworks = () => {
  try {
    const raw = fs.readFileSync(BRIDGED_NETWORKS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.networks)) return [];
    return parsed.networks.filter(n => typeof n === 'string' && /^[a-zA-Z0-9_.-]+$/.test(n));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('bridged-networks: read failed:', e.message);
    return [];
  }
};

const saveBridgedNetworks = (networks) => {
  try {
    fs.mkdirSync(path.dirname(BRIDGED_NETWORKS_PATH), { recursive: true });
    const payload = {
      networks: Array.from(new Set(networks)).filter(Boolean).sort(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(BRIDGED_NETWORKS_PATH, JSON.stringify(payload, null, 2));
  } catch (e) {
    // Persistence is best-effort — a failure here means the auto-reattach
    // won't fire next boot, but the in-process bridge succeeded so we don't
    // surface this to the user.
    console.warn('bridged-networks: write failed:', e.message);
  }
};

const rememberBridgedNetwork = (network) => {
  if (!network) return;
  const current = loadBridgedNetworks();
  if (current.includes(network)) return;
  saveBridgedNetworks([...current, network]);
};

const forgetBridgedNetwork = (network) => {
  const current = loadBridgedNetworks();
  if (!current.includes(network)) return;
  saveBridgedNetworks(current.filter(n => n !== network));
};

// Run once at startup. For each persisted network, ensure helix-gateway is
// attached. Network gone (404) → drop from the list and move on. Other
// failures → log and leave the entry so the next boot can retry.
//
// Reconnects fan out in parallel: each `network.connect` is wrapped in its
// own 5s timeout and a user with N bridged networks shouldn't wait N×5s on
// boot if Docker is slow. Each reconnect's outcome is independent.
const reconcileBridgedNetworks = async (docker) => {
  const wanted = loadBridgedNetworks();
  if (wanted.length === 0) return;
  const sidecar = TARGET_CONTAINER();
  let attached;
  try {
    const inspect = await withDockerTimeout(docker.getContainer(sidecar).inspect(), 'container.inspect', 5_000);
    attached = new Set(Object.keys(inspect.NetworkSettings?.Networks || {}));
  } catch (e) {
    // Sidecar isn't running yet (compose up still spinning, or user paused
    // the gateway). Reconcile is opportunistic — try again next boot.
    console.log(`bridged-networks: skipping reconcile (gateway not inspectable: ${e.message})`);
    return;
  }
  const todo = wanted.filter(net => !attached.has(net));
  if (todo.length === 0) return;
  const results = await Promise.all(todo.map(async net => {
    try {
      await withDockerTimeout(docker.getNetwork(net).connect({ Container: sidecar }), 'network.connect', 5_000);
      console.log(`bridged-networks: re-attached ${sidecar} to ${net}`);
      return { net, drop: false };
    } catch (e) {
      if (e.statusCode === 404) {
        console.log(`bridged-networks: dropping ${net} (network no longer exists)`);
        return { net, drop: true };
      }
      if (e.statusCode !== 403 && !/already exists/i.test(e.message || '')) {
        console.warn(`bridged-networks: failed to re-attach ${net}: ${e.message}`);
        errorLog.push('bridged-networks.reconcile', `${net}: ${e.message}`);
      }
      return { net, drop: false };
    }
  }));
  const dropped = results.filter(r => r.drop).map(r => r.net);
  if (dropped.length) saveBridgedNetworks(wanted.filter(n => !dropped.includes(n)));
};

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
      errorLog.push('gateway.recreate.stop', `stop ${name}: ${e.message}`);
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
        errorLog.push('gateway.recreate.network', `pre-start connect to ${net}: ${e.message}`);
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

  // POST apply Step 1's env changes by recreating the gateway. Compose
  // evaluates env_file at container CREATE time, not at restart, so editing
  // HELIX_ENDPOINT/HELIX_API_KEY/X_SOURCE in the UI and pressing "Save &
  // initialize" requires a full recreate to take effect.
  //
  // Network attachment is *not* this route's job — Step 3 owns wiring
  // helix-gateway to the customer's collector network via the
  // /bridge-network and /unbridge-network routes. The pre-1.0.6 behavior
  // here also did an APP_URL-driven auto-bridge, but tying network logic
  // to a URL field that doubles as a dashboard deep-link conflated two
  // unrelated concerns and confused users about what APP_URL controls.
  // APP_URL is now strictly metadata for the dashboard "Open application"
  // link; this endpoint ignores it.
  app.post('/api/lifecycle/bridge', async (req, res) => {
    const sidecarName = TARGET_CONTAINER();

    // Ensure the helix-bridge network exists (idempotent) so Step 3's
    // manual-Option-B path has somewhere to land.
    try {
      await docker.createNetwork({ Name: 'helix-bridge' });
    } catch (e) {
      if (e.statusCode !== 409) console.warn('Network create warning:', e.message);
    }

    try {
      await recreateGateway(docker, sidecarName);
    } catch (e) {
      return res.status(500).json({
        error: 'Gateway recreate failed — env changes may not have taken effect',
        details: e.message,
      });
    }
    res.json({ message: 'Gateway recreated with updated environment' });
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
      errorLog.push('bridge-network.recreate', e.message);
      return res.status(500).json({
        error: 'Network attached but gateway recreate failed — telemetry may not flow until restart',
        details: e.message,
        network,
      });
    }
    rememberBridgedNetwork(network);
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
      // Same detector the listing endpoint uses, so a container the UI shows
      // as a candidate is the same one this route will restart. Without the
      // shared helper this previously matched only on image regex and missed
      // vendor-distro collectors that exposed 4317/4318.
      const sidecarName = TARGET_CONTAINER();
      const isCollector = detectCollectorContainers(containers, { sidecarName }).some(d => d.name === name);
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

  // POST wipe wizard state and start fresh. Clears the configurator-managed
  // .env values, drops the bridged-networks persistence, and recreates the
  // gateway with a clean environment. Does NOT touch UI_AUTH_PASSWORD or
  // IS_DEMO_INSTALL (deployment config, not wizard state) and does NOT wipe
  // the OTel trace store (separate concern; users can reset that from the
  // dashboard if they need a clean data slate too).
  app.post('/api/lifecycle/reset-onboarding', async (req, res) => {
    const sidecarName = TARGET_CONTAINER();
    const WIZARD_KEYS = ['HELIX_ENDPOINT', 'HELIX_API_KEY', 'X_SOURCE', 'APP_URL', 'BUSINESS_SERVICE_KEY', 'HELIX_EVENTS_ENDPOINT'];

    // 0. Halt any in-flight Step 0 Layer 2 synthetic run and wipe its record
    //    so the panel returns to its idle pre-run state after the reset.
    //    Done first so the loop doesn't keep POSTing to the gateway as we
    //    recreate it below.
    try { clearSyntheticRun(); } catch { /* best effort */ }

    // 1. Clear the wizard-managed .env values. Preserve other lines (like
    //    UI_AUTH_PASSWORD or TARGET_CONTAINER_NAME) so deployment config
    //    survives the reset.
    try {
      const envContent = fs.readFileSync(ENV_PATH, 'utf8');
      const lines = envContent.split('\n').map(line => {
        for (const key of WIZARD_KEYS) {
          if (line.startsWith(`${key}=`)) return `${key}=`;
        }
        return line;
      });
      fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
      for (const key of WIZARD_KEYS) {
        process.env[key] = '';
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to clear .env', details: e.message });
    }

    // 2. Drop persisted bridged-networks so the next boot's reconcile doesn't
    //    re-attach the gateway to whatever the user just walked away from.
    saveBridgedNetworks([]);

    // 3. Recreate the gateway with the cleared environment. Best-effort —
    //    even if the recreate fails, the env and persistence are cleared
    //    and a manual restart from the dashboard will pick up the fresh
    //    values. Networks attached at runtime drop on the recreate.
    let recreateError = null;
    try {
      await recreateGateway(docker, sidecarName);
    } catch (e) {
      recreateError = e.message;
      console.warn('reset-onboarding: recreate failed:', e.message);
      errorLog.push('reset-onboarding.recreate', e.message);
    }

    res.json({
      message: 'Onboarding reset',
      clearedKeys: WIZARD_KEYS,
      recreateError,
    });
  });

  // POST detach the sidecar from a previously-bridged network. Mirrors the
  // bridge-network route in reverse: disconnect helix-gateway from the
  // named network, drop the network from the persisted list, and recreate
  // the gateway so its OTLP listener stops accepting on that interface
  // (otherwise the customer collector could still resolve & post traffic
  // until the next gateway restart — confusing during the "I attached the
  // wrong network" recovery case).
  app.post('/api/lifecycle/unbridge-network', async (req, res) => {
    const { network } = req.body || {};
    const sidecarName = TARGET_CONTAINER();
    if (!network || typeof network !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(network)) {
      return res.status(400).json({ error: 'Invalid network name' });
    }
    // Refuse to detach from our own primary network — that's how
    // helix-gateway and helix-configurator talk to each other; detaching it
    // would brick the dashboard until a recreate.
    if (network === 'helix-bridge') {
      return res.status(400).json({ error: 'Refusing to detach from helix-bridge (gateway and configurator share it)' });
    }
    try {
      await withDockerTimeout(
        docker.getNetwork(network).disconnect({ Container: sidecarName }),
        'network.disconnect',
        10_000,
      );
    } catch (e) {
      if (e.statusCode === 404) {
        // Network gone, or sidecar wasn't on it. Still purge from
        // persistence so future reconciles don't try to re-attach.
        forgetBridgedNetwork(network);
        return res.status(404).json({ error: `Network "${network}" not found or sidecar wasn't attached` });
      }
      if (sendDockerTimeoutResponse(res, e)) return;
      return res.status(500).json({ error: 'Failed to detach network', details: e.message });
    }
    forgetBridgedNetwork(network);
    // Recreate so the OTLP listener drops the interface cleanly. Without
    // this, the listener stays bound to the now-detached network on
    // sockets that opened at start time — confusing because the customer
    // collector would think it's still connected.
    try {
      await recreateGateway(docker, sidecarName);
    } catch (e) {
      return res.status(500).json({
        error: 'Network detached but gateway recreate failed — restart it from the dashboard to refresh the listener',
        details: e.message,
        network,
      });
    }
    res.json({ message: `Detached ${sidecarName} from ${network}`, network });
  });

  // GET the persisted list of networks the gateway is supposed to be bridged
  // to. Surfaced for the dashboard so the user can see what survives a
  // compose recreate, and to debug a stale entry.
  app.get('/api/lifecycle/bridged-networks', (req, res) => {
    res.json({ networks: loadBridgedNetworks() });
  });

  // DELETE a stale entry. Doesn't disconnect the gateway from the network
  // now — just stops the next reconcile from re-attaching it. Useful when a
  // customer renames or removes a compose network and the configurator's
  // persisted memory of it is what's wrong.
  app.delete('/api/lifecycle/bridged-networks/:network', (req, res) => {
    const network = req.params.network;
    if (!network || !/^[a-zA-Z0-9_.-]+$/.test(network)) {
      return res.status(400).json({ error: 'Invalid network name' });
    }
    if (!loadBridgedNetworks().includes(network)) {
      return res.status(404).json({ error: `Network "${network}" was not in the persisted list` });
    }
    forgetBridgedNetwork(network);
    res.json({ removed: network, networks: loadBridgedNetworks() });
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

  // Fire-and-forget: best-effort re-attach helix-gateway to networks the
  // user previously bridged. Doesn't block route registration — the rest
  // of the API is reachable immediately. If the gateway isn't running yet
  // (compose-up still spinning), the reconcile bails out quietly and the
  // user can retry by clicking Bridge again from Step 3.
  reconcileBridgedNetworks(docker).catch(e => {
    console.warn('bridged-networks: reconcile threw:', e.message);
    errorLog.push('bridged-networks.reconcile', `reconcile threw: ${e.message}`);
  });

  // Watchdog: re-run the bridge reconcile every ~5 min so a network
  // dropped after boot (compose down/up on a peer, manual disconnect,
  // etc.) heals without requiring a configurator restart. Configurable
  // via env var; 0 disables. unref'd so it doesn't block process exit.
  const watchdogIntervalMs = Number.parseInt(process.env.BRIDGED_NETWORKS_WATCHDOG_INTERVAL_MS, 10);
  const effectiveInterval = Number.isFinite(watchdogIntervalMs) ? watchdogIntervalMs : 5 * 60 * 1000;
  if (effectiveInterval > 0) {
    setInterval(() => {
      reconcileBridgedNetworks(docker).catch(e => {
        console.warn('bridged-networks: watchdog threw:', e.message);
        errorLog.push('bridged-networks.watchdog', e.message);
      });
    }, effectiveInterval).unref();
  }
}

module.exports = { register };
