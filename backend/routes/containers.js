// Container discovery + helix-bridge attach/detach routes. Powers:
//   - the "Discovered Services" slide-out panel on the dashboard
//   - the container-inspect call Step 2 uses to pick auto/manual instrumentation
//   - the /api/services base-tokens endpoint the frontend uses to compute
//     Helix deep-link URLs (despite the legacy name, this route doesn't
//     actually enumerate Docker services — it just returns env-derived tokens)
const fs = require('fs').promises;
const { isValidContainerName } = require('../util');

const VERSION = require('../package.json').version;

// Convert dockerode listContainers output to our { id, name, image, networks } shape.
const mapContainer = (c) => {
  const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
  const networks = Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}).join(',');
  return { id: c.Id, name, image: c.Image, networks };
};

function register(app, { docker }) {
  // GET base tokens (Helix endpoint / tenant / source / business-service key) the
  // frontend uses to build deep-link URLs. Name is legacy — doesn't enumerate
  // Docker services.
  app.get('/api/services', (req, res) => {
    try {
      res.json({
        debugId: `VERSION_${VERSION}_CLEAN`,
        baseUrl: (process.env.HELIX_ENDPOINT || '').replace(/\/$/, ''),
        tenantId: (process.env.HELIX_API_KEY || '').split('::')[0] || '',
        source: process.env.X_SOURCE || '',
        businessServiceKey: process.env.BUSINESS_SERVICE_KEY || '',
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to generate base tokens' });
    }
  });

  // GET all local containers for auto-attach. Excludes our own containers
  // (helix-* and the configurator) so the discovered-services list isn't
  // dominated by infrastructure.
  app.get('/api/containers', async (req, res) => {
    try {
      const list = await docker.listContainers();
      const containers = list
        .map(mapContainer)
        .filter(c => !c.name.includes('helix') && !c.name.includes('configurator'));
      res.json(containers);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list containers', details: e.message });
    }
  });

  // GET all local containers including helix-* infrastructure. Used by the
  // ops-only "containers" view; the customer-facing discovery uses
  // /api/containers (above) with the helix filter.
  app.get('/api/containers/full', async (req, res) => {
    try {
      const list = await docker.listContainers();
      const containers = list
        .map(mapContainer)
        .filter(c => !c.name.includes('configurator')); // Only exclude the UI itself
      res.json(containers);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list containers', details: e.message });
    }
  });

  // GET inspect a container for instrumentation detection. The wizard uses this
  // on Step 2 to pick the right path:
  //   - hasOtelEnv:        the app uses OTEL_EXPORTER_OTLP_* env vars (SDK auto-instrument)
  //   - hasCollectorConfig: a *.yaml mount looks like an OTel Collector config
  //                        (has both `receivers:` and `service:` sections)
  // When exactly one is true, Step 2 hides the tab picker and shows only that
  // path. When both / neither are true, the user gets the picker.
  app.get('/api/containers/inspect/:name', async (req, res) => {
    const { name } = req.params;
    if (!isValidContainerName(name)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    try {
      const info = await docker.getContainer(name).inspect();
      const env = (info.Config && info.Config.Env) || [];
      const otelVars = env.filter(e => e.startsWith('OTEL_'));
      const hasEndpoint = otelVars.some(e => e.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT='));

      // Look for a likely collector config among the bind mounts. We check the
      // host-side path because the container path might be anything (e.g.,
      // /etc/otelcol-contrib/config.yaml). The signal is structural: a YAML
      // containing both `receivers:` and `service:` at column 0 is almost
      // certainly an OTel Collector config.
      let collectorConfigPath = null;
      let hasCollectorConfig = false;
      const mounts = info.Mounts || [];
      for (const m of mounts) {
        if (m.Type !== 'bind' || !m.Source) continue;
        if (!/\.ya?ml$/i.test(m.Source)) continue;
        try {
          const content = await fs.readFile(m.Source, 'utf8');
          if (/^receivers:/m.test(content) && /^service:/m.test(content)) {
            collectorConfigPath = m.Source;
            hasCollectorConfig = true;
            break;
          }
        } catch { /* unreadable mount, skip */ }
      }

      res.json({
        name,
        hasOtelEnv: otelVars.length > 0,
        hasEndpoint,
        otelVars: otelVars.map(e => e.split('=')[0]), // names only — values may contain secrets
        hasCollectorConfig,
        collectorConfigPath,
      });
    } catch (e) {
      res.status(404).json({ error: 'Container not found', details: e.message });
    }
  });

  // POST attach container to helix-bridge.
  app.post('/api/containers/attach', async (req, res) => {
    const { containerName } = req.body;
    if (!isValidContainerName(containerName)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    try {
      await docker.getNetwork('helix-bridge').connect({ Container: containerName });
      res.json({ message: `Container ${containerName} attached to helix-bridge` });
    } catch (e) {
      // 403 from the API means already connected — treat as success.
      if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
        return res.json({ message: `Container ${containerName} already attached to helix-bridge` });
      }
      res.status(500).json({ error: 'Failed to attach container', details: e.message });
    }
  });

  // POST disconnect container from helix-bridge.
  app.post('/api/containers/disconnect', async (req, res) => {
    const { containerName } = req.body;
    if (!isValidContainerName(containerName)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    try {
      await docker.getNetwork('helix-bridge').disconnect({ Container: containerName });
      res.json({ message: `Container ${containerName} disconnected from helix-bridge` });
    } catch (e) {
      if (/not connected/i.test(e.message || '')) {
        return res.json({ message: `Container ${containerName} was not connected` });
      }
      res.status(500).json({ error: 'Failed to disconnect container', details: e.message });
    }
  });
}

module.exports = { register };
