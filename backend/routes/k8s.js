// backend/routes/k8s.js
// Phase 1 "Generate K8s chart": stream a self-contained Helm chart (or preview
// it as JSON) built from live configurator state. Generate-only — no cluster calls.
// Reuses the archiver streaming pattern from routes/demo.js. Registered under
// requireAuth (an authed dashboard action).
const fs = require('fs').promises;
const archiver = require('archiver');
const { buildChartFiles, streamChartArchive } = require('../k8sChart');

const INSTALL_COMMAND = 'helm install helix ./helix-otel --set helix.apiKey=<TenantID::AccessKey::SecretKey>';
const CHART_FILES = [
  'helix-otel/Chart.yaml',
  'helix-otel/values.yaml',
  'helix-otel/config/gateway-collector.yaml',
  'helix-otel/templates/gateway-configmap.yaml',
  'helix-otel/templates/gateway-deployment.yaml',
  'helix-otel/templates/gateway-service.yaml',
  'helix-otel/templates/secret.yaml',
  'helix-otel/templates/viewer-deployment.yaml',
  'helix-otel/templates/viewer-service.yaml',
  'helix-otel/templates/viewer-pvc.yaml',
];

const wantsViewer = (req) => String(req.query.viewer ?? 'true').toLowerCase() !== 'false';

function register(app, { configPath, projectRoot }) {
  // Build the two generated files from live state, or send an error response.
  // Returns null after responding on failure.
  async function generate(req, res) {
    let collectorYaml;
    try {
      collectorYaml = await fs.readFile(configPath, 'utf8');
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
      files: CHART_FILES,
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
