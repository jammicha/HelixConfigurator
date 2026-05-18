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
// 5% of traces inject a payment failure (stripe-mock returns ERROR, error
// propagates up). 2% of traces inflate inventory-db latency to simulate
// contention. The two are independent — a trace can hit both, neither, or
// either.
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

  const injectPaymentFailure = Math.random() < 0.05;
  const injectInventoryContention = Math.random() < 0.02;
  // 30% of traces skip notification (out-of-stock branch); inventory always present.
  const includeNotification = Math.random() > 0.3;

  // Child latencies — sampled first so the root span's duration covers them.
  const cartLatency = logNormalMs(SERVICE_PROFILES['cart-api'].median, SERVICE_PROFILES['cart-api'].sigma);
  const invMedian = injectInventoryContention ? 80 : SERVICE_PROFILES['inventory-db'].median;
  const invLatency = logNormalMs(invMedian, SERVICE_PROFILES['inventory-db'].sigma);
  const stripeLatency = logNormalMs(SERVICE_PROFILES['stripe-mock'].median, SERVICE_PROFILES['stripe-mock'].sigma);
  const paymentOwnLatency = logNormalMs(SERVICE_PROFILES['payment-service'].median, SERVICE_PROFILES['payment-service'].sigma);
  const paymentLatency = stripeLatency + paymentOwnLatency;
  const notifyLatency = includeNotification
    ? logNormalMs(SERVICE_PROFILES['notification-svc'].median, SERVICE_PROFILES['notification-svc'].sigma)
    : 0;

  const rootOwnLatency = 5 + Math.random() * 10;
  const rootLatency = cartLatency + invLatency + paymentLatency + notifyLatency + rootOwnLatency;

  const rootSpanId = randomHex(8);
  const cartSpanId = randomHex(8);
  const invSpanId = randomHex(8);
  const paymentSpanId = randomHex(8);
  const stripeSpanId = randomHex(8);
  const notifySpanId = randomHex(8);

  // Build spans in causal order so timestamps stack realistically.
  let cursor = baseMs;
  const rootStartMs = cursor;
  cursor += 1; // checkout-web does a tiny bit of work before fanning out

  const cartStartMs = cursor;
  const invStartMs = cartStartMs + (cartLatency - invLatency) * 0.4; // inventory-db is called mid-cart
  cursor = cartStartMs + cartLatency;

  const paymentStartMs = cursor;
  const stripeStartMs = paymentStartMs + paymentOwnLatency * 0.3;
  cursor = paymentStartMs + paymentLatency;

  const notifyStartMs = cursor;

  // Build the resourceSpans array — one entry per service.
  const resourceSpans = [
    {
      resource: resourceForService('checkout-web'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: rootSpanId, name: 'POST /checkout',
          startMs: rootStartMs, durationMs: rootLatency,
          errored: injectPaymentFailure,
          errorMessage: injectPaymentFailure ? 'downstream payment failed' : undefined,
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
          errored: false,
        })],
      }],
    },
    {
      resource: resourceForService('inventory-db'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: invSpanId, parentSpanId: cartSpanId,
          name: 'SELECT stock', startMs: invStartMs, durationMs: invLatency,
          errored: false,
        })],
      }],
    },
    {
      resource: resourceForService('payment-service'),
      scopeSpans: [{
        scope: { name: 'step-zero-demo' },
        spans: [buildSpan({
          traceId, spanId: paymentSpanId, parentSpanId: rootSpanId,
          name: 'POST /charge', startMs: paymentStartMs, durationMs: paymentLatency,
          errored: injectPaymentFailure,
          errorMessage: injectPaymentFailure ? 'card_declined' : undefined,
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
          errored: injectPaymentFailure,
          errorMessage: injectPaymentFailure ? 'card_declined' : undefined,
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

  // Correlated log records — one or two short messages per trace.
  const logResources = [
    {
      resource: resourceForService('payment-service'),
      scopeLogs: [{
        scope: { name: 'step-zero-demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: paymentSpanId, startMs: paymentStartMs,
          message: injectPaymentFailure ? 'card_declined: insufficient funds' : 'payment authorized',
        })],
      }],
    },
    {
      resource: resourceForService('inventory-db'),
      scopeLogs: [{
        scope: { name: 'step-zero-demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: invSpanId, startMs: invStartMs,
          message: 'stock decremented',
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
              errored: injectPaymentFailure, startMs: rootStartMs,
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
