// backend/routes/k8s.js
// Phase 1 "Generate K8s chart": stream a self-contained Helm chart (or preview
// it as JSON) built from live configurator state. Generate-only — no cluster calls.
// Reuses the archiver streaming pattern from routes/demo.js. Registered under
// requireAuth (an authed dashboard action).
const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const { buildChartFiles, streamChartArchive } = require('../k8sChart');

const INSTALL_COMMAND = 'helm install helix ./helix-otel --set helix.apiKey=<TenantID::AccessKey::SecretKey>';

// Recursively list all files under <projectRoot>/helix-otel/ as relative paths
// like `helix-otel/Chart.yaml`, then append the two generated-file paths.
// Computed once per register() call since the skeleton is static.
function listChartFiles(projectRoot) {
  const skeletonRoot = path.join(projectRoot, 'helix-otel');
  const entries = fsSync.readdirSync(skeletonRoot, { recursive: true });
  const skeletonFiles = entries
    .map(e => path.join('helix-otel', e).replace(/\\/g, '/'))
    .filter(p => fsSync.statSync(path.join(projectRoot, p)).isFile());
  const generated = [
    'helix-otel/values.yaml',
    'helix-otel/config/gateway-collector.yaml',
  ];
  return [...new Set([...skeletonFiles, ...generated])].sort();
}

const wantsViewer = (req) => String(req.query.viewer ?? 'true').toLowerCase() !== 'false';

function register(app, { configPath, projectRoot }) {
  const chartFiles = listChartFiles(projectRoot);
  // Build the two generated files from live state, or send an error response.
  // Returns null after responding on failure.
  async function generate(req, res) {
    let collectorYaml;
    try {
      collectorYaml = await fsPromises.readFile(configPath, 'utf8');
    } catch {
      res.status(500).json({ error: 'Failed to read gateway config' });
      return null;
    }
    try {
      return buildChartFiles({
        collectorYaml,
        endpoint: process.env.HELIX_ENDPOINT || '',
        xSource: process.env.X_SOURCE || '',
        viewerEnabled: wantsViewer(req),
      });
    } catch (e) {
      if (e.code === 'INVALID_COLLECTOR_YAML') {
        res.status(400).json({ error: 'Invalid collector YAML', mark: e.mark });
      } else {
        res.status(500).json({ error: 'Failed to build chart', details: e.message });
      }
      return null;
    }
  }

  app.get('/api/k8s/chart/preview', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    res.json({
      viewerEnabled: wantsViewer(req),
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      installCommand: INSTALL_COMMAND,
      files: chartFiles,
    });
  });

  app.get('/api/k8s/chart', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="helix-otel-chart.zip"');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('k8s chart archive error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);
    streamChartArchive(archive, { projectRoot, files });
    archive.finalize();
  });
}

module.exports = { register };
