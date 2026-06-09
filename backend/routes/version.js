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
  // Cache the GitHub lookup: /api/version is public and unauthenticated GitHub
  // allows 60 req/hr per IP — uncached, any visitor (or a reload-happy tab)
  // could burn the limit and blind the update banner for everyone behind the
  // same NAT. Successes live 1h; failures 5min so transient outages retry soon.
  const OK_TTL_MS = 60 * 60 * 1000, FAIL_TTL_MS = 5 * 60 * 1000;
  let cache = null; // { latest: string|null, expires: epoch-ms }
  app.get('/api/version', async (req, res) => {
    let latest = null;
    const now = Date.now();
    if (cache && cache.expires > now) {
      latest = cache.latest;
    } else {
      try {
        latest = normalize(await fetchLatestTag());
        cache = { latest, expires: now + OK_TTL_MS };
      } catch {
        // offline-safe
        cache = { latest: null, expires: now + FAIL_TTL_MS };
      }
    }
    // String inequality, not semver ordering — a downgrade also reads as
    // "update available". Acceptable for a single-tenant operator tool.
    const updateAvailable = !!latest && latest !== normalize(current);
    res.json({ current: normalize(current), latest, updateAvailable });
  });
}
module.exports = { register };
