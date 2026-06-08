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

const KEY_PLACEHOLDER = '<TenantID::AccessKey::SecretKey>';

function buildCommands({ handoff }) {
  const key = handoff ? KEY_PLACEHOLDER : (process.env.HELIX_API_KEY || KEY_PLACEHOLDER);
  return {
    secretCommand: `kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='${key}'`,
    installCommand: 'helm install helix ./helix-otel --set helix.existingSecret=helix-key',
  };
}

const chartFilesCache = new Map();
function listChartFiles(projectRoot) {
  if (chartFilesCache.has(projectRoot)) return chartFilesCache.get(projectRoot);
  const generated = [
    'helix-otel/values.yaml',
    'helix-otel/config/gateway-collector.yaml',
  ];
  let skeletonFiles = [];
  try {
    const skeletonRoot = path.join(projectRoot, 'helix-otel');
    skeletonFiles = fsSync.readdirSync(skeletonRoot, { recursive: true })
      .map(e => path.join('helix-otel', e).replace(/\\/g, '/'))
      .filter(p => {
        try { return fsSync.statSync(path.join(projectRoot, p)).isFile(); }
        catch { return false; }
      });
  } catch (e) {
    console.warn(`k8s: chart skeleton missing at ${path.join(projectRoot, 'helix-otel')} (${e.code || e.message}); chart generation will be unavailable.`);
  }
  const result = [...new Set([...skeletonFiles, ...generated])].sort();
  chartFilesCache.set(projectRoot, result);
  return result;
}

const getTarget = (req) => String(req.query.target || 'local') === 'remote' ? 'remote' : 'local';
const wantsHandoff = (req) => String(req.query.handoff) === 'true';

function register(app, { configPath, projectRoot }) {
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
        target: getTarget(req),
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
    const handoff = wantsHandoff(req);
    const { secretCommand, installCommand } = buildCommands({ handoff });
    res.json({
      target: getTarget(req),
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      secretCommand,
      installCommand,
      keyEmbedded: !handoff && !!process.env.HELIX_API_KEY,
      files: listChartFiles(projectRoot),
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
