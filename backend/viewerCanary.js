// backend/viewerCanary.js
// End-to-end proof that the gateway's local viewer fan-out actually works.
//
// The existing /api/diagnostics/inject-trace endpoint reports success as soon
// as the GATEWAY accepts a span, which is exactly the half of the path that
// was never broken. This closes the loop: inject a uniquely-tagged span into
// the gateway's OTLP receiver, then wait for that specific trace id to come
// back through otlphttp/helix_local_viewer into our own store.
//
// A shell probe inside the gateway container is not an option: the collector
// contrib image ships without /bin/sh. Using the real exporter over the real
// path is a stronger signal in any case.
const crypto = require('node:crypto');
const axios = require('axios');
const { resolveGatewayOtlpBase, DIAGNOSTIC_NAMESPACE } = require('./util');

const CANARY_SERVICE_NAME = 'helix-configurator-canary';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildCanaryPayload = (traceId, spanId, nowMs) => ({
  resourceSpans: [{
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: CANARY_SERVICE_NAME } },
        // The shared internal namespace, NOT a canary-specific one: this span
        // traverses the gateway's full pipeline, so it also ships to
        // otlphttp/bmchelix and lands in the customer's Helix tenant. Keeping
        // service.name canary-specific is what makes it filterable there.
        { key: 'service.namespace', value: { stringValue: DIAGNOSTIC_NAMESPACE } },
      ],
    },
    scopeSpans: [{
      spans: [{
        traceId,
        spanId,
        name: 'viewer-fanout-canary',
        kind: 1,
        // BigInt, not Number: epoch-ms * 1e6 lands past MAX_SAFE_INTEGER, so
        // the product is an inexact double whose digits survive only because
        // shortest-round-trip printing happens to recover them.
        startTimeUnixNano: String(BigInt(nowMs) * 1000000n),
        endTimeUnixNano: String((BigInt(nowMs) + 1n) * 1000000n),
        status: { code: 1 },
      }],
    }],
  }],
});

const GATEWAY_UNREACHABLE_FIX =
  'The configurator could not reach the gateway OTLP receiver. Check that the '
  + 'gateway container is running and that port 4318 is published, or set '
  + 'GATEWAY_OTLP_URL in .env if you remapped it.';

const FANOUT_FAILED_FIX =
  'The gateway accepted the span but it never came back through the local viewer '
  + 'exporter. Check the gateway logs for otlphttp/helix_local_viewer errors. A bare '
  + '"EOF" there means something accepts the connection and closes it without '
  + 'responding, which usually means a stale Docker port proxy owns the IPv4 side of '
  + 'the configurator port. Delivery to your Helix tenant is unaffected.';

const runViewerCanary = async ({
  otelStore,
  otlpBase = resolveGatewayOtlpBase(),
  timeoutMs = 15000,
  pollIntervalMs = 500,
  axiosImpl = axios,
  sleep = defaultSleep,
  traceId = crypto.randomBytes(16).toString('hex'),
} = {}) => {
  const startedAt = Date.now();
  const spanId = crypto.randomBytes(8).toString('hex');
  const elapsed = () => Date.now() - startedAt;

  try {
    await axiosImpl.post(
      `${otlpBase}/v1/traces`,
      buildCanaryPayload(traceId, spanId, Date.now()),
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
    );
  } catch (e) {
    return {
      verdict: 'gateway-unreachable',
      traceId,
      detail: e.message,
      remediation: GATEWAY_UNREACHABLE_FIX,
      elapsedMs: elapsed(),
    };
  }

  const deadline = startedAt + timeoutMs;
  for (;;) {
    const trace = otelStore.getTrace(traceId);
    if (trace && Array.isArray(trace.spans) && trace.spans.length > 0) {
      return { verdict: 'ok', traceId, detail: '', remediation: '', elapsedMs: elapsed() };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  return {
    verdict: 'fanout-failed',
    traceId,
    detail: `Span accepted by the gateway but not received back within ${timeoutMs}ms.`,
    remediation: FANOUT_FAILED_FIX,
    elapsedMs: elapsed(),
  };
};

module.exports = { runViewerCanary, CANARY_SERVICE_NAME };
