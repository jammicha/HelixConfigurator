// backend/routes/version.js
// Public update-check. Compares the embedded version to the latest GitHub
// release tag. Best-effort: any failure → updateAvailable:false (offline-safe).
const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';

async function defaultFetchLatestTag() {
  // Note: unauthenticated GitHub has a 60 req/hr-per-IP rate limit. The banner
  // fetches /api/version once per page load, so this is fine; add caching here
  // if /api/version ever gets polled or called server-side in bulk.
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
      // String inequality, not semver ordering — a downgrade also reads as
      // "update available". Acceptable for a single-tenant operator tool.
      updateAvailable = !!latest && latest !== normalize(current);
    } catch { /* offline-safe */ }
    res.json({ current: normalize(current), latest, updateAvailable });
  });
}
module.exports = { register };
