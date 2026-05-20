// Step 0 Layer 3 — Instrument your apps.
// Single endpoint: POST /snippet renders the per-language auto-instrumentation
// snippet (compose patch + shell wrapper + prereqs + agent download URL) for
// the language and endpoint mode the user picked. Stateless and pure — no
// docker calls, no fs writes, no in-memory state.

const { renderSnippet, VALID_LANGUAGES, VALID_MODES } = require('./instrument-templates');

function register(app) {
  app.post('/api/step-zero/instrument/snippet', (req, res) => {
    const { language, serviceName, endpointMode } = req.body || {};
    if (!VALID_LANGUAGES.includes(language)) {
      return res.status(400).json({ error: `invalid language "${language}"`, valid: VALID_LANGUAGES });
    }
    if (!VALID_MODES.includes(endpointMode)) {
      return res.status(400).json({ error: `invalid endpointMode "${endpointMode}"`, valid: VALID_MODES });
    }
    if (!serviceName || typeof serviceName !== 'string') {
      return res.status(400).json({ error: 'serviceName is required' });
    }
    try {
      const out = renderSnippet({ language, serviceName, endpointMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register };
