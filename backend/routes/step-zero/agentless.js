// Step 0 Layer 1 — agentless collection. Each receiver here is enabled by
// a button click in the Step 0 SPA panel; the endpoint mutates the gateway's
// own collector YAML and restarts the container. The pre-mounts that make
// these receivers actually produce data (/proc, /sys, docker.sock) are added
// to docker-compose.yml separately — without them, the receivers start but
// scrape zero metrics.
const fs = require('fs');
const { addReceiverAndPipeline, hasReceiver } = require('./yaml-helpers');
const { waitForGatewaySettle, extractCollectorError } = require('../config');
const { withDockerTimeout, sendDockerTimeoutResponse } = require('../../util');

const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

// Shared atomic write-restart-rollback. Returns the route's response object
// directly so handlers stay one-liners.
const applyReceiverEdit = async ({ res, docker, containerLogs, configPath, receiverName, receiverConfig, pipelineName, pipelineSignal, exporters }) => {
  let previous;
  try {
    previous = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
  }

  let newYaml;
  try {
    newYaml = addReceiverAndPipeline(previous, {
      receiverName, receiverConfig, pipelineName, pipelineSignal, exporters,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to compute new YAML', details: e.message });
  }

  try {
    fs.writeFileSync(configPath, newYaml, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write gateway config', details: e.message });
  }

  const targetContainer = TARGET_CONTAINER();
  try {
    await withDockerTimeout(docker.getContainer(targetContainer).restart(), 'container.restart', 30_000);
  } catch (e) {
    if (sendDockerTimeoutResponse(res, e)) return;
    // Restart failed — try to roll back so we don't leave a half-applied state.
    try { fs.writeFileSync(configPath, previous, 'utf8'); } catch { /* best effort */ }
    return res.status(500).json({ error: 'Gateway restart failed; YAML rolled back', details: e.message, rolledBack: true });
  }

  // Did the gateway come back up cleanly?
  const settled = await waitForGatewaySettle(docker, containerLogs, targetContainer);
  if (!settled.running) {
    try {
      fs.writeFileSync(configPath, previous, 'utf8');
      await docker.getContainer(targetContainer).restart().catch(() => {});
    } catch { /* best effort */ }
    return res.status(500).json({
      error: `Collector rejected the new config — rolled back`,
      details: extractCollectorError(settled.recentLogs) || `Collector exited (code ${settled.exitCode})`,
      rolledBack: true,
    });
  }

  res.json({ enabled: true, receiverName, pipelineName });
};

function register(app, { docker, containerLogs, configPath }) {
  // GET enabled-state per receiver.
  app.get('/api/step-zero/agentless/status', async (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      res.json({
        hostmetrics: { enabled: hasReceiver(text, 'hostmetrics') },
        dockerstats: { enabled: hasReceiver(text, 'docker_stats') },
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
    }
  });

  // POST enable hostmetrics — one-click. Pre-mounts in docker-compose.yml
  // are a prereq; without /hostfs the scrapers will run but find no data.
  app.post('/api/step-zero/agentless/hostmetrics/enable', async (req, res) => {
    await applyReceiverEdit({
      res, docker, containerLogs, configPath,
      receiverName: 'hostmetrics',
      receiverConfig: {
        collection_interval: '30s',
        root_path: '/hostfs',
        // Scrapers are scoped to what works with just /proc + /sys mounted.
        // 'filesystem' is intentionally omitted — it would enumerate host
        // mountpoints but report zero usage because the underlying paths
        // aren't in the container's mount namespace. Add it back if/when
        // a future plan adds a /hostfs root bind.
        scrapers: {
          cpu: null,
          memory: null,
          disk: null,
          network: null,
          load: null,
        },
      },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
  });

  // POST enable docker_stats — one-click. Requires /var/run/docker.sock to
  // be mounted into the gateway container (see docker-compose.yml).
  app.post('/api/step-zero/agentless/dockerstats/enable', async (req, res) => {
    await applyReceiverEdit({
      res, docker, containerLogs, configPath,
      receiverName: 'docker_stats',
      receiverConfig: {
        endpoint: 'unix:///var/run/docker.sock',
        collection_interval: '30s',
      },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
  });
}

module.exports = { register };
