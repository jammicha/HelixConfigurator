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
  sessions.set(token, { xSource, apiKey: fakeKey(), endpoint: SIMULATED_ENDPOINT, createdAt: Date.now() });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    token,
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`helix-aiops-mock on http://localhost:${PORT}`));
}
module.exports = { app, sessions };
