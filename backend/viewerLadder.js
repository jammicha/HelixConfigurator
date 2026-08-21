// backend/viewerLadder.js
// Write a fan-out endpoint, restart the gateway, and prove the endpoint with
// the round-trip canary. On failure, try the next candidate.
//
// Scope limit, deliberately: every native candidate resolves to an IPv4 host
// address, so when another process owns the IPv4 side of the configurator's
// port no candidate can succeed. The ladder fixes the cases that ARE
// resolvable (a non-default PORT, and Linux Docker Engine where
// host.docker.internal may not resolve). The IPv4/IPv6 split-brain is named by
// the startup preflight and by /api/diagnostics/verify-fanout instead.
const fspDefault = require('fs').promises;
const { rewriteLocalViewerEndpoint } = require('./collectorFanout');
const { runViewerCanary } = require('./viewerCanary');

const writeEndpoint = async (fsp, configHostPath, rewrite, endpoint) => {
  const current = await fsp.readFile(configHostPath, 'utf8');
  const tmp = `${configHostPath}.tmp`;
  await fsp.writeFile(tmp, rewrite(current, endpoint));
  await fsp.rename(tmp, configHostPath);
};

const selectViewerEndpoint = async ({
  configHostPath,
  candidates,
  otelStore,
  restartGateway,
  fsp = fspDefault,
  canary = runViewerCanary,
  rewrite = rewriteLocalViewerEndpoint,
  // Set by callers whose candidates[0] is already what's on disk and already
  // what the gateway loaded (e.g. the pre-create rewrite in
  // createGatewayFromScratch). Skipping the write+restart for that one
  // candidate avoids a pointless restart-to-load-identical-bytes and the
  // readiness race that restart would otherwise reopen.
  skipFirstApply = false,
}) => {
  const attempts = [];
  let lastVerdict = 'fanout-failed';

  for (let i = 0; i < candidates.length; i++) {
    const endpoint = candidates[i];
    try {
      if (!(i === 0 && skipFirstApply)) {
        await writeEndpoint(fsp, configHostPath, rewrite, endpoint);
        await restartGateway();
      }
      const result = await canary({ otelStore });
      attempts.push({ endpoint, verdict: result.verdict });
      lastVerdict = result.verdict;

      if (result.verdict === 'ok') return { endpoint, verdict: 'ok', attempts };
      // A gateway we cannot reach at all is not an endpoint problem. Trying the
      // remaining candidates would restart the gateway again for nothing.
      if (result.verdict === 'gateway-unreachable') break;
    } catch (e) {
      // A write/restart/canary failure on this candidate is a failure of
      // this candidate, not a reason to abort the whole selection: record it
      // as an attempt and keep walking the ladder, so a transient error on
      // candidate N doesn't strand the yaml mid-trial (skipping the restore
      // below) or vanish into a console.warn with nothing in the diagnostics
      // trail the success path already feeds.
      attempts.push({ endpoint, verdict: 'fanout-failed', error: e.message });
      lastVerdict = 'fanout-failed';
    }
  }

  // Nothing worked. The first candidate is the best guess for the deployment
  // mode, so leave that one on disk rather than the last one tried. This only
  // rewrites the yaml, though — it does not restart, so the RUNNING gateway
  // keeps exporting to whichever candidate was tried last, not to
  // candidates[0]. Diagnostics reading live gateway behavior (Task 7) should
  // treat this file as "what the next create/recreate will try," not as
  // "what the gateway is exporting to right now."
  if (attempts.length > 1) {
    await writeEndpoint(fsp, configHostPath, rewrite, candidates[0]);
  }
  return { endpoint: null, verdict: lastVerdict, attempts };
};

module.exports = { selectViewerEndpoint };
