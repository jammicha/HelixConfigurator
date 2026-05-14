// Shared-password UI auth. If UI_AUTH_PASSWORD is unset, auth is disabled
// (open access) and the middleware is a passthrough — this is "prevent
// casual access" for tunneled demos, not real authentication. Anyone
// wanting real SSO should put a proxy in front.
const crypto = require('crypto');

const UI_AUTH_REQUIRED = !!process.env.UI_AUTH_PASSWORD;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Hash both sides to fixed-length digests, then timingSafeEqual. Hashing
// equalizes length up-front (so wrong-length guesses take the same time as
// right-length guesses) and timingSafeEqual makes the byte-compare itself
// constant-time. Either alone is insufficient.
const timingSafeStringEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// token → expiry epoch ms. Old impl was a Set without expiry, so a stale token
// remained valid until process restart. This keeps the same casual-access model
// (single shared password) but bounds session lifetime server-side.
const sessions = new Map();

const isSessionValid = (token) => {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
};

// Periodic prune so an idle process with thousands of expired tokens doesn't
// keep them around. Cheap O(n) scan; runs once an hour. unref'd so it doesn't
// block process exit.
setInterval(() => {
  const now = Date.now();
  for (const [tok, exp] of sessions.entries()) {
    if (now > exp) sessions.delete(tok);
  }
}, 60 * 60 * 1000).unref();

const parseCookies = (req) => {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
};

const requireAuth = (req, res, next) => {
  if (!UI_AUTH_REQUIRED) return next();
  // Allow auth endpoints + health through unauthenticated.
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/status' ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/health'
  ) {
    return next();
  }
  const cookies = parseCookies(req);
  if (isSessionValid(cookies.session)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};

// Register /api/auth/* routes against the Express app. Must be called BEFORE
// app.use('/api', requireAuth) so the auth endpoints themselves are reachable.
const registerAuthRoutes = (app) => {
  app.get('/api/auth/status', (req, res) => {
    if (!UI_AUTH_REQUIRED) return res.json({ required: false, authenticated: true });
    const cookies = parseCookies(req);
    res.json({ required: true, authenticated: isSessionValid(cookies.session) });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!UI_AUTH_REQUIRED) return res.json({ ok: true });
    const { password } = req.body || {};
    if (typeof password !== 'string' || !timingSafeStringEqual(password, process.env.UI_AUTH_PASSWORD)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = crypto.randomUUID();
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.session) sessions.delete(cookies.session);
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });
};

module.exports = { requireAuth, registerAuthRoutes };
