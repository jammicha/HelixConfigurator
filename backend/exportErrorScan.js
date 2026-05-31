// Pure analysis of a collector's (demuxed) Docker log text for helix-bound
// export errors. Time-aware: distinguishes errors still happening from ones
// that already cleared, so the UI can stop alarming on self-healed startup/
// restart retries. No I/O — `nowMs` is passed in for testability.

const ERROR_SIGNALS = [
  'no children to pick from', 'connection refused', 'no such host',
  'context deadline exceeded', 'permanent error', 'exporter failed',
  'exporting failed', 'failed to send', 'rpc error', 'tls handshake',
  'unauthorized', 'invalid api key',
];

// Docker logs({timestamps:true}) prefixes each line with an RFC3339Nano stamp +
// a space. Return that leading stamp's epoch ms, or null if absent/unparseable.
function leadingTimestampMs(line) {
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  const t = Date.parse(line.slice(0, sp));
  return Number.isNaN(t) ? null : t;
}

// Strip a leading Docker RFC3339 timestamp token (+ space) for display, so the
// returned lines read like before (the app's own log still carries its time).
function stripLeadingTimestamp(line) {
  return leadingTimestampMs(line) == null ? line : line.slice(line.indexOf(' ') + 1);
}

// rawLog: demuxed log text; lines may carry a leading Docker timestamp.
// Returns { lines, lastErrorAgeSec, ongoing } or null when there are no matches.
// ongoing = a matched error within `windowSec`. If no timestamp is parseable,
// be conservative and treat as ongoing (don't hide a possibly-real error).
function analyzeCollectorErrorLog(rawLog, nowMs, { windowSec = 90 } = {}) {
  const matched = String(rawLog || '').split('\n').filter((l) => {
    const lower = l.toLowerCase();
    if (!lower.includes('helix')) return false;
    return ERROR_SIGNALS.some((sig) => lower.includes(sig));
  });
  if (matched.length === 0) return null;
  let newestMs = null;
  for (const l of matched) {
    const ms = leadingTimestampMs(l);
    if (ms != null && (newestMs == null || ms > newestMs)) newestMs = ms;
  }
  const lastErrorAgeSec = newestMs == null ? null : Math.max(0, Math.round((nowMs - newestMs) / 1000));
  const ongoing = lastErrorAgeSec == null ? true : lastErrorAgeSec <= windowSec;
  return { lines: matched.slice(-5).map(stripLeadingTimestamp), lastErrorAgeSec, ongoing };
}

module.exports = { ERROR_SIGNALS, leadingTimestampMs, stripLeadingTimestamp, analyzeCollectorErrorLog };
