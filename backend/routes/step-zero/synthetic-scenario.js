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

const resourceForService = (serviceName) => ({
  attributes: [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.namespace', value: { stringValue: 'Helix-Configurator-Demo' } },
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
      attributes: [{ key: 'retry.attempt', value: { intValue: 1 } }],
    }),
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t2Start, durationMs: attempt2,
      statusCode: 2, errorMessage: 'service_unavailable',
      attributes: [{ key: 'retry.attempt', value: { intValue: 2 } }],
    }),
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t3Start, durationMs: attempt3,
      attributes: [{ key: 'retry.attempt', value: { intValue: 3 } }],
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

  // Cart-api attributes: cache.hit (and cold-start if applicable).
  const cartAttributes = [];
  if (injectCartCacheMiss) cartAttributes.push({ key: 'cache.hit', value: { boolValue: false } });
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
      { key: 'db.name', value: { stringValue: 'inventory' } },
      { key: 'db.namespace', value: { stringValue: 'inventory' } },
      { key: 'db.operation', value: { stringValue: 'SELECT' } },
      { key: 'db.sql.table', value: { stringValue: 'stock' } },
      {
        key: 'db.statement',
        value: { stringValue: `SELECT quantity, last_updated FROM stock WHERE item_id = ${itemId}` },
      },
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

  // Checkout-web attributes (cold-start).
  const checkoutAttributes = [];
  if (coldStartService === 'checkout-web') checkoutAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Payment-service attributes (cold-start).
  const paymentAttributes = [];
  if (coldStartService === 'payment-service') paymentAttributes.push({ key: 'startup.cold', value: { boolValue: true } });

  // Notification-svc attributes (template.render_ms + cold-start).
  const notifyAttributes = [];
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

  // Metrics: per-service latency observations as a sum metric (one data point
  // per trace; aggregation happens server-side when we batch).
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
  ];

  return {
    traces: { resourceSpans },
    logs: { resourceLogs: logResources },
    metrics: { resourceMetrics: metricResources },
  };
};

module.exports = { generateTrace, buildSpan, buildExceptionEvent };
