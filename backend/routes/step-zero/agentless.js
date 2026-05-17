// Step 0 Layer 1 — agentless collection. Each receiver here is enabled by
// a button click in the Step 0 SPA panel; the endpoint mutates the gateway's
// own collector YAML and restarts the container. The pre-mounts that make
// these receivers actually produce data (/proc, /sys, docker.sock) are added
// to docker-compose.yml separately — without them, the receivers start but
// scrape zero metrics.
const fs = require('fs');
const { hasReceiver } = require('./yaml-helpers');

function register(app, { docker, configPath }) {
  // GET enabled-state per receiver. UI polls every 5s to flip cards green
  // once enable completes.
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
}

module.exports = { register };
