// Pure-function generator for one e-commerce trace + its correlated logs and
// metrics. Returns OTLP-shaped JSON payloads ready for HTTP POST. No I/O.
//
// Topology:
//   checkout-web ──▶ cart-api ──▶ inventory-db
//          │
//          ├─────▶ payment-service ──▶ stripe-mock
//          │
//          └─────▶ notification-svc
//
// Three independent diagnostic patterns weave into the same baseline. Each
// Math.random() draw is independent, so a trace can hit 0, 1, 2, or all 3.
// About 85% of traces remain baseline-healthy.
//
//   Pattern A — Stripe-mock latency tail (8%)
//     stripe-mock runs 200-400ms (uniform) instead of ~40ms. Slowness cascades
//     up through payment-service and checkout-web because those durations are
//     sums of their children. No error — just slow.
//
//   Pattern B — Inventory-db connection cascade (3%)
//     inventory-db errors with "connection refused". Status propagates up:
//     cart-api → "upstream inventory unavailable", checkout-web → "checkout
//     failed: inventory unavailable".
//
//   Pattern C — N+1 query pattern (5%)
//     cart-api makes 5-10 sequential calls to inventory-db (each ~5ms) instead
//     of one. All siblings under cart-api. Cart-api duration extends to cover
//     them all.
const crypto = require('crypto');

// Log-normal sampler. Returns a positive number with median ~ exp(mu)
// and spread controlled by sigma. Picked because real latencies are skewed
// right (a few slow tails dragging up the mean).
const logNormalMs = (medianMs, sigma) => {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(Math.log(medianMs) + sigma * z);
};

// Service profiles: median latency in ms + spread.
const SERVICE_PROFILES = {
  'cart-api':         { median: 8,  sigma: 0.4 },
  'inventory-db':     { median: 5,  sigma: 0.3 },
  'payment-service':  { median: 35, sigma: 0.45 },
  'stripe-mock':      { median: 40, sigma: 0.5 },
  'notification-svc': { median: 12, sigma: 0.4 },
};

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const buildSpan = ({ traceId, spanId, parentSpanId, name, startMs, durationMs, errored, errorMessage }) => {
  const startNs = String(BigInt(Math.round(startMs)) * 1_000_000n);
  const endNs = String(BigInt(Math.round(startMs + durationMs)) * 1_000_000n);
  const span = {
    traceId,
    spanId,
    name,
    kind: 2, // SPAN_KIND_SERVER
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    status: { code: errored ? 2 : 1 }, // 2 = ERROR, 1 = OK
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (errored && errorMessage) span.status.message = errorMessage;
  return span;
};

const resourceForService = (serviceName) => ({
  attributes: [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.namespace', value: { stringValue: 'step-zero-demo' } },
    { key: 'deployment.environment', value: { stringValue: 'demo' } },
  ],
});

const logRecordForSpan = ({ traceId, spanId, message, startMs }) => ({
  timeUnixNano: String(BigInt(Math.round(startMs)) * 1_000_000n),
  severityNumber: 9, // INFO
  severityText: 'INFO',
  body: { stringValue: message },
  traceId,
  spanId,
});

const metricDataPoint = ({ serviceName, latencyMs, errored, startMs }) => ({
  attributes: [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'http.status_code', value: { intValue: errored ? 500 : 200 } },
  ],
  startTimeUnixNano: String(BigInt(Math.round(startMs)) * 1_000_000n),
  timeUnixNano: String(BigInt(Math.round(startMs + latencyMs)) * 1_000_000n),
  asDouble: latencyMs,
});

// Generate one trace + its bundle of logs and metrics. Returns three OTLP
// payloads ready to POST to /v1/traces, /v1/logs, /v1/metrics respectively.
const generateTrace = () => {
  const traceId = randomHex(16);
  const baseMs = Date.now();

  // Independent draws for each diagnostic pattern.
  const injectStripeSlowdown = Math.random() < 0.08;
  const injectInventoryError = Math.random() < 0.03;
  const injectN1 = Math.random() < 0.05;
  // 30% of traces skip notification (out-of-stock branch); inventory always present.
  const includeNotification = Math.random() > 0.3;

  // Inventory-db latencies. Baseline is one call; N+1 generates 5-10 sequential
  // calls (~5ms each). All children of cart-api.
  const invCount = injectN1 ? 5 + Math.floor(Math.random() * 6) : 1; // 5..10 when N+1
  const invLatencies = Array.from({ length: invCount }, () =>
    injectN1
      ? 4 + Math.random() * 2 // ~5ms each (uniform 4-6ms) for N+1
      : logNormalMs(SERVICE_PROFILES['inventory-db'].median, SERVICE_PROFILES['inventory-db'].sigma),
  );
  const invTotalLatency = invLatencies.reduce((a, b) => a + b, 0);

  // Cart-api owns its own work + must cover all inventory-db children. When N+1
  // fires, force cart-api to cover the sequential sum + small buffer.
  const cartOwnLatency = logNormalMs(SERVICE_PROFILES['cart-api'].median, SERVICE_PROFILES['cart-api'].sigma);
  const n1Buffer = 4;
  const cartLatency = injectN1
    ? Math.max(cartOwnLatency, invTotalLatency + n1Buffer)
    : cartOwnLatency;

  // Stripe-mock: 200-400ms uniform when slowdown injected, else log-normal ~40ms.
  const stripeLatency = injectStripeSlowdown
    ? 200 + Math.random() * 200
    : logNormalMs(SERVICE_PROFILES['stripe-mock'].median, SERVICE_PROFILES['stripe-mock'].sigma);
  const paymentOwnLatency = logNormalMs(SERVICE_PROFILES['payment-service'].median, SERVICE_PROFILES['payment-service'].sigma);
  const paymentLatency = stripeLatency + paymentOwnLatency;
  const notifyLatency = includeNotification
    ? logNormalMs(SERVICE_PROFILES['notification-svc'].median, SERVICE_PROFILES['notification-svc'].sigma)
    : 0;

  const rootOwnLatency = 5 + Math.random() * 10;
  const rootLatency = cartLatency + paymentLatency + notifyLatency + rootOwnLatency;

  const rootSpanId = randomHex(8);
  const cartSpanId = randomHex(8);
  const paymentSpanId = randomHex(8);
  const stripeSpanId = randomHex(8);
  const notifySpanId = randomHex(8);
  const invSpanIds = invLatencies.map(() => randomHex(8));

  // Build spans in causal order so timestamps stack realistically.
  let cursor = baseMs;
  const rootStartMs = cursor;
  cursor += 1; // checkout-web does a tiny bit of work before fanning out

  const cartStartMs = cursor;
  // Inventory-db calls fire sequentially inside cart-api. Pack them starting
  // a short way into cart-api's window so their sum still fits inside cartLatency.
  const invFirstOffset = injectN1
    ? 1
    : (cartLatency - invLatencies[0]) * 0.4;
  const invStartMsList = [];
  {
    let invCursor = cartStartMs + invFirstOffset;
    for (const inv of invLatencies) {
      invStartMsList.push(invCursor);
      invCursor += inv;
    }
  }
  cursor = cartStartMs + cartLatency;

  const paymentStartMs = cursor;
  const stripeStartMs = paymentStartMs + paymentOwnLatency * 0.3;
  cursor = paymentStartMs + paymentLatency;

  const notifyStartMs = cursor;

  // Cascade error fields for Pattern B.
  const checkoutErrMsg = injectInventoryError ? 'checkout failed: inventory unavailable' : undefined;
  const cartErrMsg = injectInventoryError ? 'upstream inventory unavailable' : undefined;
  const invErrMsg = injectInventoryError ? 'connection refused: inventory-db unreachable' : undefined;

  // Build the resourceSpans array — one entry per service.
  const resourceSpans = [
    {
      resource: resourceForService('checkout-web'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: rootSpanId, name: 'POST /checkout',
          startMs: rootStartMs, durationMs: rootLatency,
          errored: injectInventoryError,
          errorMessage: checkoutErrMsg,
        })],
      }],
    },
    {
      resource: resourceForService('cart-api'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: cartSpanId, parentSpanId: rootSpanId,
          name: 'GET /cart/items', startMs: cartStartMs, durationMs: cartLatency,
          errored: injectInventoryError,
          errorMessage: cartErrMsg,
        })],
      }],
    },
    {
      // One resource entry holds all the inventory-db sibling spans so the
      // service map still sees a single inventory-db service.
      resource: resourceForService('inventory-db'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: invLatencies.map((dur, i) => buildSpan({
          traceId, spanId: invSpanIds[i], parentSpanId: cartSpanId,
          name: 'SELECT stock', startMs: invStartMsList[i], durationMs: dur,
          errored: injectInventoryError,
          errorMessage: invErrMsg,
        })),
      }],
    },
    {
      resource: resourceForService('payment-service'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: paymentSpanId, parentSpanId: rootSpanId,
          name: 'POST /charge', startMs: paymentStartMs, durationMs: paymentLatency,
          errored: false,
        })],
      }],
    },
    {
      resource: resourceForService('stripe-mock'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: stripeSpanId, parentSpanId: paymentSpanId,
          name: 'POST /v1/charges', startMs: stripeStartMs, durationMs: stripeLatency,
          errored: false,
        })],
      }],
    },
  ];

  if (includeNotification) {
    resourceSpans.push({
      resource: resourceForService('notification-svc'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: notifySpanId, parentSpanId: rootSpanId,
          name: 'email send', startMs: notifyStartMs, durationMs: notifyLatency,
          errored: false,
        })],
      }],
    });
  }

  // Correlated log records — one or two short messages per trace. Inventory log
  // points to the first inventory span (the one that failed in the error case).
  const logResources = [
    {
      resource: resourceForService('payment-service'),
      scopeLogs: [{
        scope: { name: 'step-zero-demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: paymentSpanId, startMs: paymentStartMs,
          message: 'payment authorized',
        })],
      }],
    },
    {
      resource: resourceForService('inventory-db'),
      scopeLogs: [{
        scope: { name: 'step-zero-demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: invSpanIds[0], startMs: invStartMsList[0],
          message: injectInventoryError ? 'db connection refused' : 'stock decremented',
        })],
      }],
    },
  ];

  // Metrics: per-service latency observations as a sum metric (one data point
  // per trace; aggregation happens server-side when we batch).
  const metricResources = [
    {
      resource: resourceForService('checkout-web'),
      scopeMetrics: [{
        scope: { name: 'step-zero-demo' },
        metrics: [{
          name: 'http.server.request.duration',
          unit: 'ms',
          gauge: {
            dataPoints: [metricDataPoint({
              serviceName: 'checkout-web', latencyMs: rootLatency,
              errored: injectInventoryError, startMs: rootStartMs,
            })],
          },
        }],
      }],
    },
  ];

  return {
    traces: { resourceSpans },
    logs: { resourceLogs: logResources },
    metrics: { resourceMetrics: metricResources },
  };
};

module.exports = { generateTrace };
