// backend/routes/version.js
// Public update-check. Compares the embedded version to the latest GitHub
// release tag. Best-effort: any failure → updateAvailable:false (offline-safe).
const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';

async function defaultFetchLatestTag() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'accept': 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j = await r.json();
  return j.tag_name;
}

const normalize = (t) => String(t || '').replace(/^v/, '');

function register(app, { current, fetchLatestTag = defaultFetchLatestTag } = {}) {
  app.get('/api/version', async (req, res) => {
    let latest = null, updateAvailable = false;
    try {
      latest = normalize(await fetchLatestTag());
      updateAvailable = !!latest && latest !== normalize(current);
    } catch { /* offline-safe */ }
    res.json({ current: normalize(current), latest, updateAvailable });
  });
}
module.exports = { register };
