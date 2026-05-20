// Shared-password UI auth. If UI_AUTH_PASSWORD is unset, auth is disabled
// (open access) and the middleware is a passthrough — this is "prevent
// casual access" for tunneled demos, not real authentication. Anyone
// wanting real SSO should put a proxy in front.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

const UI_AUTH_REQUIRED = !!process.env.UI_AUTH_PASSWORD;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const ENV_PATH = path.join(__dirname, '..', '.env');
// The configurator's own container name. Override via SELF_CONTAINER_NAME if
// the compose service is renamed; default matches the shipped compose file.
const SELF_CONTAINER = () => process.env.SELF_CONTAINER_NAME || 'helix-configurator';

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

// Write UI_AUTH_PASSWORD to .env, replacing the existing line or appending if
// not present. Empty newPassword removes the line entirely (disables auth on
// next process boot). Preserves the rest of the file verbatim.
const persistUiPasswordToEnv = (newPassword) => {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // .env doesn't exist yet; start fresh.
  }
  let found = false;
  lines = lines.map(line => {
    if (line.startsWith('UI_AUTH_PASSWORD=')) {
      found = true;
      return newPassword ? `UI_AUTH_PASSWORD=${newPassword}` : null;
    }
    return line;
  }).filter(l => l !== null);
  if (!found && newPassword) {
    // Append at the end with a leading newline if the file doesn't end in one.
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`UI_AUTH_PASSWORD=${newPassword}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
};

// Restart the configurator's own container via the Docker socket. The
// container's restart policy doesn't matter — the daemon explicitly stops
// and starts the container when we call container.restart(). Called as
// fire-and-forget; the HTTP response to the client should flush BEFORE we
// trigger the restart so the user sees a success status.
const scheduleSelfRestart = (delayMs = 300) => {
  setTimeout(async () => {
    try {
      const docker = new Docker();
      const container = docker.getContainer(SELF_CONTAINER());
      await container.restart({ t: 5 });
    } catch (e) {
      console.error('scheduleSelfRestart: failed:', e.message);
    }
  }, delayMs);
};

const clearAllSessions = () => sessions.clear();

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

  // Set or clear the UI auth password. Empty / null password disables auth.
  //
  // When auth is currently REQUIRED, this route is gated by the standard
  // requireAuth middleware — only signed-in users can change or remove the
  // password (verified by the fact that this route is NOT in the
  // unauthenticated allowlist in requireAuth above).
  //
  // When auth is NOT required (bootstrap), the middleware is a passthrough
  // so any user reaching the URL can set the first password. That's
  // consistent with the existing model: open access until someone locks it.
  //
  // The change requires a configurator restart to take effect — Node reads
  // UI_AUTH_PASSWORD once at boot. We persist to .env, clear all sessions
  // (so old cookies die immediately), respond OK, then schedule a
  // self-restart via the Docker socket. Clients should poll /api/health
  // after submit and reload when the server returns.
  app.post('/api/auth/set-password', (req, res) => {
    const raw = (req.body || {}).password;
    const wantsDisable = raw == null || raw === '';
    const newPassword = typeof raw === 'string' ? raw.trim() : '';

    if (!wantsDisable) {
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'password must be a string' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
      }
    }

    try {
      persistUiPasswordToEnv(wantsDisable ? '' : newPassword);
      clearAllSessions();
      res.json({ ok: true, restarting: true });
      // Trigger restart AFTER the response flushes. The container will die,
      // Docker will bring it back with the new env, and the client polls
      // /api/health to detect it's reachable again.
      scheduleSelfRestart(300);
    } catch (e) {
      res.status(500).json({ error: 'Failed to persist password: ' + e.message });
    }
  });
};

module.exports = { requireAuth, registerAuthRoutes };
