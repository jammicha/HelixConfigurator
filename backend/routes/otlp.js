// OTLP ingest endpoints — the gateway fans out traces and logs here so the
// configurator's local View OTel Data page can render them. Public routes:
// the gateway speaks plain HTTP from inside the helix-bridge network, and
// requiring the UI session cookie would block it.
const zlib = require('zlib');
const { extractSpans, extractLogRecords } = require('../otelStore');

// Decode an OTLP/HTTP request body. The gateway is configured for JSON +
// no compression, but we still tolerate gzip in case the user wires their
// own collector at this endpoint.
const decodeOtlpBody = (req) => {
  let buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const enc = (req.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
  else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('protobuf')) {
    // Protobuf encoding not supported here — the local_store exporter is
    // configured for JSON. Surface a clear error so a misconfig is obvious
    // in the gateway logs.
    throw new Error('OTLP protobuf encoding is not supported by /api/otlp; configure the exporter with encoding: json');
  }
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
};

function register(app, { otelStore }) {
  // POST /api/otlp/traces — public ingest from the gateway fan-out.
  // The configurator-side session cookie is irrelevant on this hop, and
  // requiring auth would block the gateway. We bind the listener to the
  // in-cluster docker network only via the helix-bridge / port-forward setup.
  app.post('/api/otlp/traces', (req, res) => {
    try {
      const body = decodeOtlpBody(req);
      const spans = extractSpans(body);
      otelStore.ingestSpans(spans);
      // OTLP/HTTP success response is an empty ExportTraceServiceResponse.
      res.json({});
    } catch (e) {
      console.error('OTLP traces ingest error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/otlp/logs — receives OTLP log records from helix-gateway's
  // fan-out pipeline. Logs are stored in log_records and surfaced both
  // per-trace (in the trace detail drawer) and as a cross-trace feed in the
  // Logs & Errors tab.
  app.post('/api/otlp/logs', (req, res) => {
    try {
      const body = decodeOtlpBody(req);
      const logs = extractLogRecords(body);
      otelStore.ingestLogs(logs);
      res.json({});
    } catch (e) {
      console.error('OTLP logs ingest error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { register };
