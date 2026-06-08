#!/usr/bin/env node
// helix-aiops-mock/server.js
// Standalone local mock of the BMC Helix "Manage OTel" page. Mints a demo
// session and serves a tiny install script that downloads the pre-built native
// package from GitHub Releases. Hosts no packages itself. No tunnel.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { renderBashInstaller, renderPowerShellInstaller } = require('./installScripts');

const PORT = Number.parseInt(process.env.PORT, 10) || 9000;
const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';
const SIMULATED_ENDPOINT = 'https://your-tenant.onbmc.com';
const TTL_MS = 60 * 60 * 1000;

const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(t);
}, 10 * 60 * 1000).unref();

const fakeKey = () => `FAKE-KEY-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/configure', (req, res) => {
  const xSource = (req.body && req.body.xSource || '').trim();
  if (!xSource) return res.status(400).json({ error: 'xSource is required' });
  const token = crypto.randomBytes(16).toString('hex');
  const session = { xSource, apiKey: fakeKey(), endpoint: SIMULATED_ENDPOINT, createdAt: Date.now() };
  sessions.set(token, session);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    token,
    xSource: session.xSource,
    apiKey: session.apiKey,        // simulated; surfaced so the page can show it like the real wizard
    endpoint: session.endpoint,
    sh: `curl -fsSL ${base}/install/${token}.sh | bash`,
    ps1: `iwr ${base}/install/${token}.ps1 | iex`,
  });
});

app.get('/install/:token.sh', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).type('text/plain').send('# session expired\nexit 1\n');
  res.type('text/x-shellscript').send(renderBashInstaller({ session: s, repo: REPO }));
});

app.get('/install/:token.ps1', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).type('text/plain').send('# session expired\nexit 1\n');
  res.type('text/plain').send(renderPowerShellInstaller({ session: s, repo: REPO }));
});

// Best-effort: pop the default browser at the page on startup (skipped in
// tests/CI or when NO_OPEN is set). Never fatal if no opener is available.
function openBrowser(url) {
  if (process.env.NO_OPEN || process.env.CI) return;
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no opener */ }
}

if (require.main === module) {
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  helix-aiops-mock running → ${url}\n  (Ctrl-C to stop)\n`);
    openBrowser(url);
  });
}
module.exports = { app, sessions };
