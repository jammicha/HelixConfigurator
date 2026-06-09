// backend/routes/k8s.js
// Phase 1 "Generate K8s chart": stream a self-contained Helm chart (or preview
// it as JSON) built from live configurator state. Generate-only — no cluster calls.
// Uses archiver to stream the chart zip. Registered under requireAuth (an authed
// dashboard action).
const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const { buildChartFiles, streamChartArchive } = require('../k8sChart');
const { chartDirForEngine } = require('../k8sChart/buildChart');
const { prereqCommands } = require('../k8sChart/operatorPrereqs');

const getEngine = (req) => String(req.query.engine || 'deployment') === 'operator' ? 'operator' : 'deployment';

const KEY_PLACEHOLDER = '<TenantID::AccessKey::SecretKey>';

function buildCommands({ handoff, engine }) {
  const key = handoff ? KEY_PLACEHOLDER : (process.env.HELIX_API_KEY || KEY_PLACEHOLDER);
  const chartDir = chartDirForEngine(engine);
  const commands = {
    secretCommand: `kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='${key}'`,
    installCommand: `helm install helix ./${chartDir} --set helix.existingSecret=helix-key`,
  };
  if (engine === 'operator') commands.prereqs = prereqCommands();
  return commands;
}

const chartFilesCache = new Map();
function listChartFiles(projectRoot, engine = 'deployment') {
  const dir = chartDirForEngine(engine);
  const cacheKey = `${projectRoot}::${dir}`;
  if (chartFilesCache.has(cacheKey)) return chartFilesCache.get(cacheKey);
  const generated = [`${dir}/values.yaml`, `${dir}/config/gateway-collector.yaml`];
  let skeletonFiles = [];
  try {
    const skeletonRoot = path.join(projectRoot, dir);
    skeletonFiles = fsSync.readdirSync(skeletonRoot, { recursive: true })
      .map(e => path.join(dir, e).replace(/\\/g, '/'))
      .filter(p => { try { return fsSync.statSync(path.join(projectRoot, p)).isFile(); } catch { return false; } });
  } catch (e) {
    console.warn(`k8s: chart skeleton missing at ${path.join(projectRoot, dir)} (${e.code || e.message}); chart generation will be unavailable.`);
  }
  const result = [...new Set([...skeletonFiles, ...generated])].sort();
  chartFilesCache.set(cacheKey, result);
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
        engine: getEngine(req),
      });
    } catch (e) {
      if (e.code === 'INVALID_COLLECTOR_YAML') res.status(400).json({ error: 'Invalid collector YAML', mark: e.mark });
      else res.status(500).json({ error: 'Failed to build chart', details: e.message });
      return null;
    }
  }

  app.get('/api/k8s/chart/preview', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    const engine = getEngine(req);
    const handoff = wantsHandoff(req);
    const cmds = buildCommands({ handoff, engine });
    res.json({
      target: getTarget(req),
      engine,
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      secretCommand: cmds.secretCommand,
      installCommand: cmds.installCommand,
      ...(cmds.prereqs ? { prereqs: cmds.prereqs } : {}),
      keyEmbedded: !handoff && !!process.env.HELIX_API_KEY,
      files: listChartFiles(projectRoot, engine),
    });
  });

  app.get('/api/k8s/chart', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    const engine = getEngine(req);
    const chartDir = chartDirForEngine(engine);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${chartDir}-chart.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('k8s chart archive error:', err);
      if (!res.headersSent) res.status(500).end(); else res.end();
    });
    archive.pipe(res);
    streamChartArchive(archive, { projectRoot, files, engine });
    archive.finalize();
  });
}

module.exports = { register };
