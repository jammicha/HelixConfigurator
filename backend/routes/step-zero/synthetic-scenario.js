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
// Eight independent diagnostic patterns weave into the same baseline. Each
// Math.random() draw is independent, so a trace can hit any combination.
// About 75% of traces remain baseline-healthy.
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
//
//   Pattern D — Cart-api cache-miss tail (5%)
//     cart-api runs ~5x slower (~40ms vs ~8ms baseline). cache.hit=false
//     attribute attached to the cart-api span.
//
//   Pattern E — Inventory-db connection-pool wait (4%)
//     each inventory-db span runs ~3x slower (~15ms vs ~5ms). Every inv-db
//     span in the trace gets db.pool.wait_ms=10. Compounds with N+1.
//
//   Pattern F — Notification slow email render (2%)
//     notification-svc runs ~8x slower (~100ms vs ~12ms) with
//     template.render_ms=95. Only fires when notification fires (70% of traces).
//
//   Pattern G — Retry storm (2%)
//     stripe-mock attempted 3 times: 2 timeouts (~30ms each, status=2) + 1
//     successful retry (~40ms or 200-400ms if Pattern A also fires). Each
//     attempt carries retry.attempt=N. Root status remains 1 (success).
//
//   Pattern H — Cold-start spike (0.5%)
//     adds 1.5-2s of cold-start latency to one randomly-chosen service
//     (one of checkout-web/cart-api/payment-service/notification-svc) and
//     stamps startup.cold=true on that service's span. Latency propagates
//     up naturally because parent durations are sums of their children.
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

const COLD_START_TARGETS = ['checkout-web', 'cart-api', 'payment-service', 'notification-svc'];

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const buildSpan = ({ traceId, spanId, parentSpanId, name, startMs, durationMs, errored, errorMessage, statusCode, attributes, kind, events }) => {
  const startNs = String(BigInt(Math.round(startMs)) * 1_000_000n);
  const endNs = String(BigInt(Math.round(startMs + durationMs)) * 1_000_000n);
  // Allow explicit statusCode override (used by retry storm so we can mark
  // failed attempts without an "errored" cascade flag). Successful spans
  // default to UNSET (0) — per OTel spec OK (1) is reserved for spans an
  // app developer has explicitly validated, and Helix dashboards filter on
  // STATUS_CODE_UNSET by default, so emitting OK hides traces.
  const code = statusCode !== undefined ? statusCode : (errored ? 2 : 0);
  const span = {
    traceId,
    spanId,
    name,
    kind: kind !== undefined ? kind : 2, // default SPAN_KIND_SERVER; DB/client spans pass kind: 3
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    status: { code },
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (code === 2 && errorMessage) span.status.message = errorMessage;
  if (attributes && attributes.length) span.attributes = attributes;
  if (events && events.length) span.events = events;
  return span;
};

// OTel `exception` span event. otelStore reads exception.type/message/stacktrace off
// these (preferring them over the span.error fallback); deriveProbableCause then sets
// error_type/error_message from them. `code_location` comes separately from the span's
// own code.* attributes. timeMs = when the exception was recorded (span end is fine).
const buildExceptionEvent = ({ type, message, stacktrace, timeMs }) => ({
  name: 'exception',
  timeUnixNano: String(BigInt(Math.round(timeMs)) * 1_000_000n),
  attributes: [
    { key: 'exception.type', value: { stringValue: type } },
    { key: 'exception.message', value: { stringValue: message } },
    ...(stacktrace ? [{ key: 'exception.stacktrace', value: { stringValue: stacktrace } }] : []),
  ],
});

// Short, believable Python traceback for the inventory connection failure.
const INVENTORY_DB_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "services/inventory/repositories/stock_repository.py", line 142, in get_stock',
  '    cur.execute(_STOCK_QUERY, (item_id,))',
  '  File "/usr/local/lib/python3.11/site-packages/psycopg2/__init__.py", line 122, in connect',
  '    conn = _connect(dsn, connection_factory=connection_factory, **kwasync)',
  'psycopg2.OperationalError: connection refused: inventory-db unreachable',
].join('\n');

// Stripe client code location (the payment-service call site that raised/handled the error).
const STRIPE_CLIENT_CODE_ATTRS = [
  { key: 'code.filepath', value: { stringValue: 'services/payment/clients/stripe_client.py' } },
  { key: 'code.function', value: { stringValue: 'charge' } },
  { key: 'code.lineno', value: { intValue: 88 } },
];
const stripeTraceback = (type, message) => [
  'Traceback (most recent call last):',
  '  File "services/payment/clients/stripe_client.py", line 88, in charge',
  '    resp = self._session.post(_STRIPE_CHARGES_URL, json=payload, timeout=5)',
  `${type}: ${message}`,
].join('\n');
const STRIPE_TIMEOUT_MSG = "HTTPSConnectionPool(host='api.stripe.com', port=443): Read timed out. (read timeout=5)";
const STRIPE_503_MSG = '503 Server Error: Service Unavailable for url: /v1/charges';

// --- Resource identity ----------------------------------------------------
// A believable polyglot fleet: each service runs a different language/runtime,
// so the trace drawer's Resource section reads like a real OTel deployment
// rather than a uniform mock.
const SERVICE_RUNTIME = {
  'checkout-web':     { version: '4.2.1', language: 'nodejs', runtimeName: 'nodejs',  runtimeVersion: '20.11.1',   runtimeDesc: 'Node.js v20.11.1',                         sdk: '1.27.0' },
  'cart-api':         { version: '2.8.0', language: 'go',     runtimeName: 'go',      runtimeVersion: 'go1.22.2',  runtimeDesc: 'go version go1.22.2 linux/amd64',           sdk: '1.27.0' },
  'payment-service':  { version: '3.1.4', language: 'python', runtimeName: 'cpython', runtimeVersion: '3.11.8',    runtimeDesc: 'CPython 3.11.8',                            sdk: '1.24.0' },
  'inventory-db':     { version: '1.9.2', language: 'python', runtimeName: 'cpython', runtimeVersion: '3.11.8',    runtimeDesc: 'CPython 3.11.8',                            sdk: '1.24.0' },
  'stripe-mock':      { version: '0.7.0', language: 'go',     runtimeName: 'go',      runtimeVersion: 'go1.22.2',  runtimeDesc: 'go version go1.22.2 linux/amd64',           sdk: '1.27.0' },
  'notification-svc': { version: '2.0.5', language: 'java',   runtimeName: 'OpenJDK Runtime Environment', runtimeVersion: '17.0.10+7', runtimeDesc: 'Eclipse Adoptium OpenJDK 64-Bit Server VM 17.0.10+7', sdk: '1.36.0' },
};
const K8S_NAMESPACE = 'helix-demo';
const uuidish = () => `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;

// Per-service identity is computed once and cached, so every span and metric a
// service emits — across all traces in this process — shares one stable
// instance id / pod / host / pid, exactly as a single running replica would.
const SERVICE_IDENTITY = {};
const identityFor = (serviceName) => {
  if (!SERVICE_IDENTITY[serviceName]) {
    const pod = `${serviceName}-${randomHex(3)}-${randomHex(2).slice(0, 5)}`;
    SERVICE_IDENTITY[serviceName] = {
      instanceId: uuidish(),
      pod,
      host: pod, // in K8s the container hostname is the pod name
      node: `gke-helix-demo-pool-${randomHex(2)}`,
      containerId: randomHex(32),
      pid: 1 + (crypto.randomBytes(2).readUInt16BE(0) % 32000),
    };
  }
  return SERVICE_IDENTITY[serviceName];
};

const resourceForService = (serviceName) => {
  const rt = SERVICE_RUNTIME[serviceName] || SERVICE_RUNTIME['checkout-web'];
  const id = identityFor(serviceName);
  return {
    attributes: [
      // Identity — service.namespace is the Helix join key; do NOT change it.
      { key: 'service.name', value: { stringValue: serviceName } },
      { key: 'service.namespace', value: { stringValue: 'Helix-Configurator-Demo' } },
      { key: 'service.version', value: { stringValue: rt.version } },
      { key: 'service.instance.id', value: { stringValue: id.instanceId } },
      { key: 'deployment.environment', value: { stringValue: 'demo' } },
      { key: 'deployment.environment.name', value: { stringValue: 'demo' } },
      // Telemetry SDK
      { key: 'telemetry.sdk.name', value: { stringValue: 'opentelemetry' } },
      { key: 'telemetry.sdk.language', value: { stringValue: rt.language } },
      { key: 'telemetry.sdk.version', value: { stringValue: rt.sdk } },
      // Process / runtime
      { key: 'process.pid', value: { intValue: id.pid } },
      { key: 'process.runtime.name', value: { stringValue: rt.runtimeName } },
      { key: 'process.runtime.version', value: { stringValue: rt.runtimeVersion } },
      { key: 'process.runtime.description', value: { stringValue: rt.runtimeDesc } },
      // Host / OS
      { key: 'host.name', value: { stringValue: id.host } },
      { key: 'host.arch', value: { stringValue: 'amd64' } },
      { key: 'os.type', value: { stringValue: 'linux' } },
      { key: 'os.description', value: { stringValue: 'Debian GNU/Linux 12 (bookworm)' } },
      // Container / Kubernetes
      { key: 'container.id', value: { stringValue: id.containerId } },
      { key: 'container.runtime', value: { stringValue: 'containerd' } },
      { key: 'k8s.namespace.name', value: { stringValue: K8S_NAMESPACE } },
      { key: 'k8s.pod.name', value: { stringValue: id.pod } },
      { key: 'k8s.deployment.name', value: { stringValue: serviceName } },
      { key: 'k8s.container.name', value: { stringValue: serviceName } },
      { key: 'k8s.node.name', value: { stringValue: id.node } },
      // Cloud
      { key: 'cloud.provider', value: { stringValue: 'aws' } },
      { key: 'cloud.platform', value: { stringValue: 'aws_eks' } },
      { key: 'cloud.region', value: { stringValue: 'us-east-1' } },
    ],
  };
};

// --- Span attribute builders ----------------------------------------------
// Base HTTP / messaging semantic-convention attributes that every span of a
// service carries on the happy path. Per-pattern extras (cache.hit, retry.attempt,
// startup.cold, db.pool.wait_ms …) are appended by the caller on top of these.
const randByte = () => crypto.randomBytes(1)[0];
const randomClientIp = () => `203.0.113.${1 + (randByte() % 254)}`;
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];
const pick = (arr) => arr[randByte() % arr.length];

// service → its HTTP face (method/route/scheme/host/port).
const SERVICE_HTTP = {
  'checkout-web':    { method: 'POST', route: '/checkout',   scheme: 'https', host: 'shop.example.com',               port: 443 },
  'cart-api':        { method: 'GET',  route: '/cart/items', scheme: 'http',  host: 'cart-api.helix-demo.svc',        port: 8000 },
  'payment-service': { method: 'POST', route: '/charge',     scheme: 'https', host: 'payment-service.helix-demo.svc', port: 8443 },
  'stripe-mock':     { method: 'POST', route: '/v1/charges', scheme: 'https', host: 'api.stripe.com',                 port: 443 },
};
const httpAttrs = (serviceName, status) => {
  const h = SERVICE_HTTP[serviceName];
  return [
    { key: 'http.request.method', value: { stringValue: h.method } },
    { key: 'url.path', value: { stringValue: h.route } },
    { key: 'url.scheme', value: { stringValue: h.scheme } },
    { key: 'http.route', value: { stringValue: h.route } },
    { key: 'http.response.status_code', value: { intValue: status } },
    { key: 'server.address', value: { stringValue: h.host } },
    { key: 'server.port', value: { intValue: h.port } },
    { key: 'network.protocol.name', value: { stringValue: 'http' } },
    { key: 'network.protocol.version', value: { stringValue: '1.1' } },
  ];
};
const stripeAttrs = (status) => [
  ...httpAttrs('stripe-mock', status),
  { key: 'url.full', value: { stringValue: 'https://api.stripe.com/v1/charges' } },
  { key: 'stripe.api_version', value: { stringValue: '2024-04-10' } },
];
const messagingAttrs = () => [
  { key: 'messaging.system', value: { stringValue: 'smtp' } },
  { key: 'messaging.operation', value: { stringValue: 'publish' } },
  { key: 'messaging.destination.name', value: { stringValue: 'order-confirmations' } },
  { key: 'messaging.message.body.size', value: { intValue: 800 + randByte() } },
  { key: 'network.transport', value: { stringValue: 'tcp' } },
  { key: 'server.address', value: { stringValue: 'smtp.helix-demo.svc' } },
  { key: 'server.port', value: { intValue: 587 } },
];

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

// Synthetic process-level resource metrics so the trace drawer's Resources panel
// lights up from the baked-in simulator. CPU utilization (0..1) + memory RSS
// (bytes) as gauges, one data point per trace, on the same resource (service.name
// + namespace) as the spans so the viewer's service.name join lines up.
const clamp01 = (x) => Math.max(0.02, Math.min(0.99, x));
const MB = 1024 * 1024;
const processMetricsResource = (serviceName, { cpuUtil, memBytes, atMs }) => {
  const ts = String(BigInt(Math.round(atMs)) * 1_000_000n);
  const dp = (value, asInt) => ({
    attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
    timeUnixNano: ts,
    ...(asInt ? { asInt: String(Math.round(value)) } : { asDouble: value }),
  });
  return {
    resource: resourceForService(serviceName),
    scopeMetrics: [{
      scope: { name: 'Helix-Configurator-Demo' },
      metrics: [
        { name: 'process.cpu.utilization', unit: '1', gauge: { dataPoints: [dp(cpuUtil, false)] } },
        { name: 'process.memory.usage', unit: 'By', gauge: { dataPoints: [dp(memBytes, true)] } },
      ],
    }],
  };
};

// Build the sequential 3-attempt stripe-mock span list for Pattern G.
// successLatency lets the caller decide whether the successful retry is the
// normal log-normal sample or a stripe-slowdown (Pattern A) tail.
const buildRetryStormStripeSpans = ({ traceId, paymentSpanId, stripeStartMs, successLatency }) => {
  const attempt1 = logNormalMs(30, 0.3);
  const attempt2 = logNormalMs(30, 0.3);
  const attempt3 = successLatency;
  const t1Start = stripeStartMs;
  const t2Start = t1Start + attempt1;
  const t3Start = t2Start + attempt2;
  const spans = [
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t1Start, durationMs: attempt1,
      statusCode: 2, errorMessage: 'timeout',
      attributes: [...stripeAttrs(504), { key: 'retry.attempt', value: { intValue: 1 } }, ...STRIPE_CLIENT_CODE_ATTRS],
      events: [buildExceptionEvent({
        type: 'requests.exceptions.ReadTimeout', message: STRIPE_TIMEOUT_MSG,
        stacktrace: stripeTraceback('requests.exceptions.ReadTimeout', STRIPE_TIMEOUT_MSG),
        timeMs: t1Start + attempt1,
      })],
    }),
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t2Start, durationMs: attempt2,
      statusCode: 2, errorMessage: 'service_unavailable',
      attributes: [...stripeAttrs(503), { key: 'retry.attempt', value: { intValue: 2 } }, ...STRIPE_CLIENT_CODE_ATTRS],
      events: [buildExceptionEvent({
        type: 'requests.exceptions.HTTPError', message: STRIPE_503_MSG,
        stacktrace: stripeTraceback('requests.exceptions.HTTPError', STRIPE_503_MSG),
        timeMs: t2Start + attempt2,
      })],
    }),
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t3Start, durationMs: attempt3,
      attributes: [...stripeAttrs(200), { key: 'retry.attempt', value: { intValue: 3 } }],
    }),
  ];
  const totalStripeDuration = attempt1 + attempt2 + attempt3;
  return { spans, totalStripeDuration };
};

// Generate one trace + its bundle of logs and metrics. Returns three OTLP
// payloads ready to POST to /v1/traces, /v1/logs, /v1/metrics respectively.
const generateTrace = () => {
  const traceId = randomHex(16);
  const baseMs = Date.now();

  // Independent draws for each diagnostic pattern.
  const injectStripeSlowdown = Math.random() < 0.08;
  const injectInventoryError = Math.random() < 0.03;
  const injectN1 = Math.random() < 0.05;
  const injectCartCacheMiss = Math.random() < 0.05;
  const injectInvPoolWait = Math.random() < 0.04;
  const injectNotifyRenderSlow = Math.random() < 0.02;
  const injectRetryStorm = Math.random() < 0.02;
  // Cold-start rate is set to make trace-list outlier badges (>2× p95)
  // reliably visible. With Pattern A at 8%, p95 of POST /checkout inflates
  // to ~250-300ms, so the outlier threshold becomes ~500-600ms. Cold-start
  // magnitude (2500-4000ms) is well above that. The trace store caps at
  // 500 traces, so 2% × 500 = ~10 cold-start outliers in the window —
  // visible across multiple runs without being so common they dominate.
  const injectColdStart = Math.random() < 0.02;
  // 30% of traces skip notification (out-of-stock branch); inventory always present.
  const includeNotification = Math.random() > 0.3;

  // Pick a cold-start victim service if injected.
  const coldStartService = injectColdStart
    ? COLD_START_TARGETS[Math.floor(Math.random() * COLD_START_TARGETS.length)]
    : null;
  const coldStartExtraMs = injectColdStart ? 2500 + Math.random() * 1500 : 0;
  // Helper: returns the cold-start bump for a service if it's the chosen victim.
  const coldStartBumpFor = (svc) => (coldStartService === svc ? coldStartExtraMs : 0);

  // Inventory-db latencies. Baseline is one call; N+1 generates 5-10 sequential
  // calls (~5ms each). All children of cart-api. Pool-wait (Pattern E) makes
  // each call ~15ms instead of ~5ms.
  const invCount = injectN1 ? 5 + Math.floor(Math.random() * 6) : 1; // 5..10 when N+1
  const invMedian = injectInvPoolWait ? 15 : SERVICE_PROFILES['inventory-db'].median;
  const invSigma = injectInvPoolWait ? 0.3 : SERVICE_PROFILES['inventory-db'].sigma;
  const invLatencies = Array.from({ length: invCount }, () =>
    injectN1 && !injectInvPoolWait
      ? 4 + Math.random() * 2 // ~5ms each (uniform 4-6ms) for plain N+1
      : injectN1 && injectInvPoolWait
        ? 13 + Math.random() * 4 // ~15ms each for N+1 + pool wait
        : logNormalMs(invMedian, invSigma),
  );
  const invTotalLatency = invLatencies.reduce((a, b) => a + b, 0);

  // Cart-api owns its own work + must cover all inventory-db children. Cache
  // miss (Pattern D) pushes the baseline to ~40ms. Cold-start may add 1.5-2s.
  const cartBaseMedian = injectCartCacheMiss ? 40 : SERVICE_PROFILES['cart-api'].median;
  const cartOwnLatency =
    logNormalMs(cartBaseMedian, SERVICE_PROFILES['cart-api'].sigma) +
    coldStartBumpFor('cart-api');
  const n1Buffer = 4;
  const cartLatency = injectN1
    ? Math.max(cartOwnLatency, invTotalLatency + n1Buffer)
    : cartOwnLatency;

  // Stripe-mock baseline: 200-400ms uniform when slowdown injected, else log-normal ~40ms.
  // When retry storm fires, this value is reused as the SUCCESSFUL-attempt latency
  // so Pattern A + Pattern G compose naturally.
  const stripeBaseLatency = injectStripeSlowdown
    ? 200 + Math.random() * 200
    : logNormalMs(SERVICE_PROFILES['stripe-mock'].median, SERVICE_PROFILES['stripe-mock'].sigma);

  const paymentOwnLatency =
    logNormalMs(SERVICE_PROFILES['payment-service'].median, SERVICE_PROFILES['payment-service'].sigma) +
    coldStartBumpFor('payment-service');

  const notifyBaseMedian = injectNotifyRenderSlow ? 100 : SERVICE_PROFILES['notification-svc'].median;
  const notifyBaseSigma = injectNotifyRenderSlow ? 0.4 : SERVICE_PROFILES['notification-svc'].sigma;
  const notifyLatency = includeNotification
    ? logNormalMs(notifyBaseMedian, notifyBaseSigma) + coldStartBumpFor('notification-svc')
    : 0;

  const rootOwnLatency = 5 + Math.random() * 10 + coldStartBumpFor('checkout-web');

  // Span IDs.
  const rootSpanId = randomHex(8);
  const cartSpanId = randomHex(8);
  const paymentSpanId = randomHex(8);
  const stripeSpanId = randomHex(8); // single-span case
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

  // Build stripe-mock span(s). Retry storm produces 3 sequential spans;
  // otherwise a single span. The total stripe duration drives payment-service's
  // own duration so the parent covers all children.
  let stripeMockSpans;
  let totalStripeDuration;
  if (injectRetryStorm) {
    const result = buildRetryStormStripeSpans({
      traceId, paymentSpanId, stripeStartMs,
      successLatency: stripeBaseLatency, // composes naturally with Pattern A
    });
    stripeMockSpans = result.spans;
    totalStripeDuration = result.totalStripeDuration;
  } else {
    stripeMockSpans = [buildSpan({
      traceId, spanId: stripeSpanId, parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: stripeStartMs, durationMs: stripeBaseLatency,
      errored: false,
      attributes: stripeAttrs(200),
    })];
    totalStripeDuration = stripeBaseLatency;
  }

  const paymentLatency = totalStripeDuration + paymentOwnLatency;
  cursor = paymentStartMs + paymentLatency;

  const notifyStartMs = cursor;

  const rootLatency = cartLatency + paymentLatency + notifyLatency + rootOwnLatency;

  // Cascade error fields for Pattern B.
  const checkoutErrMsg = injectInventoryError ? 'checkout failed: inventory unavailable' : undefined;
  const cartErrMsg = injectInventoryError ? 'upstream inventory unavailable' : undefined;
  const invErrMsg = injectInventoryError ? 'connection refused: inventory-db unreachable' : undefined;

  // Cart-api attributes: base HTTP semconv + cache.hit (false on a miss, true
  // otherwise) and cold-start when applicable.
  const cartAttributes = [
    ...httpAttrs('cart-api', injectInventoryError ? 500 : 200),
    { key: 'http.response.body.size', value: { intValue: 200 + randByte() } },
    { key: 'cache.hit', value: { boolValue: !injectCartCacheMiss } },
  ];
  if (coldStartService === 'cart-api') cartAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Inventory-db: every span carries the standard OTel DB semantic-convention
  // attributes so /otel-data's DB detection and N+1 detector (which look for
  // db.system + db.operation, not for span-name patterns) actually fire.
  // The viewer matches on EITHER db.system or db.system.name; we emit the
  // older name for broader compatibility. db.statement varies per call so the
  // trace detail surfaces different queries, but db.operation + db.name stay
  // identical across the N+1 set so the N+1 detector groups them correctly.
  const buildInvDbAttributes = (callIndex) => {
    const itemId = 1000 + (callIndex || 0);
    const attrs = [
      { key: 'db.system', value: { stringValue: 'postgresql' } },
      { key: 'db.system.name', value: { stringValue: 'postgresql' } }, // semconv 1.27+ alias
      { key: 'db.name', value: { stringValue: 'inventory' } },
      { key: 'db.namespace', value: { stringValue: 'inventory' } },
      { key: 'db.operation', value: { stringValue: 'SELECT' } },
      { key: 'db.sql.table', value: { stringValue: 'stock' } },
      {
        key: 'db.statement',
        value: { stringValue: `SELECT quantity, last_updated FROM stock WHERE item_id = ${itemId}` },
      },
      { key: 'server.address', value: { stringValue: 'inventory-db.helix-demo.svc' } },
      { key: 'server.port', value: { intValue: 5432 } },
      { key: 'network.peer.address', value: { stringValue: '10.42.1.37' } },
      { key: 'network.transport', value: { stringValue: 'tcp' } },
    ];
    if (injectInvPoolWait) {
      attrs.push({ key: 'db.pool.wait_ms', value: { intValue: 10 } });
    }
    // In the error case, carry the code location of the failing query so the
    // Situation's code_location resolves to file:method:line.
    if (injectInventoryError) {
      attrs.push(
        { key: 'code.filepath', value: { stringValue: 'services/inventory/repositories/stock_repository.py' } },
        { key: 'code.function', value: { stringValue: 'get_stock' } },
        { key: 'code.lineno', value: { intValue: 142 } },
      );
    }
    return attrs;
  };

  // Checkout-web attributes: public-facing HTTP request + cold-start when applicable.
  const checkoutAttributes = [
    ...httpAttrs('checkout-web', injectInventoryError ? 500 : 200),
    { key: 'url.full', value: { stringValue: 'https://shop.example.com/checkout' } },
    { key: 'client.address', value: { stringValue: randomClientIp() } },
    { key: 'user_agent.original', value: { stringValue: pick(USER_AGENTS) } },
    { key: 'http.request.body.size', value: { intValue: 280 + randByte() } },
    { key: 'enduser.id', value: { stringValue: `cust_${randomHex(4)}` } },
  ];
  if (coldStartService === 'checkout-web') checkoutAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Payment-service attributes: internal HTTP charge call + business context + cold-start.
  const paymentAttributes = [
    ...httpAttrs('payment-service', 200),
    { key: 'payment.amount', value: { doubleValue: Math.round((19.99 + randByte()) * 100) / 100 } },
    { key: 'payment.currency', value: { stringValue: 'USD' } },
    { key: 'payment.method', value: { stringValue: 'card' } },
  ];
  if (coldStartService === 'payment-service') paymentAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Notification-svc attributes: messaging semconv + template.render_ms + cold-start.
  const notifyAttributes = [
    ...messagingAttrs(),
    { key: 'notification.channel', value: { stringValue: 'email' } },
  ];
  if (injectNotifyRenderSlow) notifyAttributes.push({ key: 'template.render_ms', value: { intValue: 95 } });
  if (coldStartService === 'notification-svc') notifyAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Build the resourceSpans array — one entry per service.
  const resourceSpans = [
    {
      resource: resourceForService('checkout-web'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: [buildSpan({
          traceId, spanId: rootSpanId, name: 'POST /checkout',
          startMs: rootStartMs, durationMs: rootLatency,
          errored: injectInventoryError,
          errorMessage: checkoutErrMsg,
          attributes: checkoutAttributes,
        })],
      }],
    },
    {
      resource: resourceForService('cart-api'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: [buildSpan({
          traceId, spanId: cartSpanId, parentSpanId: rootSpanId,
          name: 'GET /cart/items', startMs: cartStartMs, durationMs: cartLatency,
          errored: injectInventoryError,
          errorMessage: cartErrMsg,
          attributes: cartAttributes,
        })],
      }],
    },
    {
      // One resource entry holds all the inventory-db sibling spans so the
      // service map still sees a single inventory-db service. Each span is
      // kind=CLIENT (3) and carries the OTel DB semantic-convention
      // attributes — /otel-data's DB detection + N+1 detector look at those,
      // not at the service.name or span name.
      resource: resourceForService('inventory-db'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: invLatencies.map((dur, i) => buildSpan({
          traceId, spanId: invSpanIds[i], parentSpanId: cartSpanId,
          name: 'SELECT stock', startMs: invStartMsList[i], durationMs: dur,
          errored: injectInventoryError,
          errorMessage: invErrMsg,
          attributes: buildInvDbAttributes(i),
          kind: 3, // SPAN_KIND_CLIENT
          events: injectInventoryError ? [buildExceptionEvent({
            type: 'psycopg2.OperationalError',
            message: invErrMsg,
            stacktrace: INVENTORY_DB_TRACEBACK,
            timeMs: invStartMsList[i] + dur,
          })] : undefined,
        })),
      }],
    },
    {
      resource: resourceForService('payment-service'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: [buildSpan({
          traceId, spanId: paymentSpanId, parentSpanId: rootSpanId,
          name: 'POST /charge', startMs: paymentStartMs, durationMs: paymentLatency,
          errored: false,
          attributes: paymentAttributes,
        })],
      }],
    },
    {
      resource: resourceForService('stripe-mock'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: stripeMockSpans,
      }],
    },
  ];

  if (includeNotification) {
    resourceSpans.push({
      resource: resourceForService('notification-svc'),
      scopeSpans: [{
        scope: { name: 'Helix-Configurator-Demo' },
        spans: [buildSpan({
          traceId, spanId: notifySpanId, parentSpanId: rootSpanId,
          name: 'email send', startMs: notifyStartMs, durationMs: notifyLatency,
          errored: false,
          attributes: notifyAttributes,
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
        scope: { name: 'Helix-Configurator-Demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: paymentSpanId, startMs: paymentStartMs,
          message: 'payment authorized',
        })],
      }],
    },
    {
      resource: resourceForService('inventory-db'),
      scopeLogs: [{
        scope: { name: 'Helix-Configurator-Demo' },
        logRecords: [logRecordForSpan({
          traceId, spanId: invSpanIds[0], startMs: invStartMsList[0],
          message: injectInventoryError ? 'db connection refused' : 'stock decremented',
        })],
      }],
    },
  ];

  // Metrics: the existing per-service latency gauge, plus synthetic process
  // CPU/memory so the trace drawer's Resources panel lights up. checkout-web is
  // the trace root (the service the panel shows) and reads hotter when this trace
  // is slow or errored — reinforcing the "slow trace AND high CPU" story.
  const PROC_SERVICES = ['checkout-web', 'cart-api', 'inventory-db', 'payment-service', 'notification-svc'];
  const rootCpu = clamp01(0.30 + rootLatency / 600 + (injectInventoryError ? 0.30 : 0) + (Math.random() - 0.5) * 0.1);
  const processResources = PROC_SERVICES.map((svc) => processMetricsResource(svc, {
    cpuUtil: svc === 'checkout-web' ? rootCpu : clamp01(0.18 + Math.random() * 0.45),
    memBytes: (180 + Math.random() * 220) * MB + (svc === 'checkout-web' ? 60 * MB : 0),
    atMs: rootStartMs,
  }));
  const metricResources = [
    {
      resource: resourceForService('checkout-web'),
      scopeMetrics: [{
        scope: { name: 'Helix-Configurator-Demo' },
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
    ...processResources,
  ];

  return {
    traces: { resourceSpans },
    logs: { resourceLogs: logResources },
    metrics: { resourceMetrics: metricResources },
  };
};

module.exports = { generateTrace, buildSpan, buildExceptionEvent };
