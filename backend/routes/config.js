// Gateway config (helix-otel-collector.yaml) read/write + config templates.
// POST /api/config is atomic: syntax-check → snapshot → write → restart →
// watch the collector → roll back on rejection. So the user is never left
// with a broken pipeline because of a saved-but-rejected YAML.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateConfig } = require('../validate');

// Wait for the gateway to settle into a final state after a restart.
// Returns { running, state, exitCode, recentLogs } once stable, or once timeoutMs elapses.
const waitForGatewaySettle = async (docker, containerLogs, targetContainer, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const inspect = await docker.getContainer(targetContainer).inspect();
      const state = (inspect && inspect.State) || {};
      lastState = state;
      const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : 0;
      const upMs = startedAt ? Date.now() - startedAt : 0;
      // Healthy: running and has been running for >=2s without flipping
      if (state.Status === 'running' && upMs >= 2000) {
        return { running: true, state, exitCode: state.ExitCode };
      }
      // Already failed: exited with non-zero
      if (state.Status === 'exited') {
        const recentLogs = await containerLogs(targetContainer, { tail: 50 }).catch(() => '');
        return { running: false, state, exitCode: state.ExitCode, recentLogs };
      }
    } catch { /* container missing — keep polling */ }
    await new Promise(r => setTimeout(r, 400));
  }
  // Timed out without a definitive answer — best-effort report
  const recentLogs = await containerLogs(targetContainer, { tail: 50 }).catch(() => '');
  return {
    running: lastState && lastState.Status === 'running',
    state: lastState || {},
    exitCode: lastState && lastState.ExitCode,
    recentLogs,
  };
};

// Pull the most actionable error line out of a collector log dump.
const extractCollectorError = (logs) => {
  if (!logs) return '';
  const lines = logs.split('\n').map(l => l.trim()).filter(Boolean);
  // Prefer the last "Error:" line — collector startup writes its fatal error there.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Error:/.test(lines[i])) return lines[i];
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|invalid|cannot|failed/i.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || '';
};

function register(app, { docker, containerLogs, configPath, templatesDir }) {
  // GET current config
  app.get('/api/config', (req, res) => {
    try {
      const fileContents = fs.readFileSync(configPath, 'utf8');
      res.json({ yaml: fileContents });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read config file' });
    }
  });

  // POST update config — atomic save+restart with rollback if collector rejects the new YAML.
  app.post('/api/config', async (req, res) => {
    const { content } = req.body;
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

    // 1. Syntax check before touching the file.
    try {
      yaml.load(content);
    } catch (e) {
      if (e.mark) {
        return res.status(400).json({
          error: 'Invalid YAML syntax',
          mark: { line: e.mark.line, column: e.mark.column, message: e.reason },
        });
      }
      return res.status(400).json({ error: 'Invalid YAML syntax', details: e.message });
    }

    const warnings = validateConfig(content);

    // 2. Snapshot existing content for rollback, then write the new one.
    let previous = '';
    try { previous = fs.readFileSync(configPath, 'utf8'); } catch { /* first save */ }
    try {
      fs.writeFileSync(configPath, content, 'utf8');
    } catch (e) {
      return res.status(500).json({ error: 'Failed to write config', details: e.message });
    }

    // 3. Restart the gateway and watch what happens. If the collector rejects the
    // new YAML, restore previous content and bounce the gateway back to a known-good
    // state so the user is never left with a broken pipeline.
    try {
      await docker.getContainer(targetContainer).restart();
    } catch (e) {
      // Restart itself failed — config is on disk but gateway didn't bounce.
      return res.status(500).json({
        error: 'Config saved but gateway restart failed',
        details: e.message,
        warnings,
      });
    }

    const settled = await waitForGatewaySettle(docker, containerLogs, targetContainer);
    if (!settled.running) {
      // Roll back.
      try {
        fs.writeFileSync(configPath, previous, 'utf8');
        await docker.getContainer(targetContainer).restart().catch(() => {});
      } catch { /* best effort */ }
      return res.status(400).json({
        error: 'Config rejected by collector — rolled back',
        details: extractCollectorError(settled.recentLogs) || `Collector exited (code ${settled.exitCode})`,
        rolledBack: true,
        warnings,
      });
    }

    res.json({ message: 'Config updated successfully', warnings, restarted: true });
  });

  // GET list of available config templates
  app.get('/api/templates', (req, res) => {
    try {
      const indexPath = path.join(templatesDir, 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      // Enrich each entry with the raw template content (no env substitution
      // — the picker's "Selected" detection compares against the editor,
      // which holds raw ${env:...} references too). Best-effort: missing
      // files just omit content so the picker still lists them.
      const enriched = (Array.isArray(index) ? index : []).map(entry => {
        try {
          const yamlPath = path.join(templatesDir, `${entry.id}.yaml`);
          return { ...entry, content: fs.readFileSync(yamlPath, 'utf8') };
        } catch {
          return { ...entry };
        }
      });
      res.json(enriched);
    } catch (e) {
      res.status(500).json({ error: 'Failed to load templates', details: e.message });
    }
  });

  // GET single template content with env placeholders substituted
  app.get('/api/templates/:id', (req, res) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid template id' });
    }
    try {
      const yamlPath = path.join(templatesDir, `${id}.yaml`);
      let content = fs.readFileSync(yamlPath, 'utf8');
      content = content
        .replace(/\$\{HELIX_ENDPOINT\}/g, process.env.HELIX_ENDPOINT || '')
        .replace(/\$\{HELIX_API_KEY\}/g, process.env.HELIX_API_KEY || '')
        .replace(/\$\{X_SOURCE\}/g, process.env.X_SOURCE || '');
      res.json({ id, content });
    } catch (e) {
      res.status(404).json({ error: 'Template not found' });
    }
  });
}

module.exports = { register };
