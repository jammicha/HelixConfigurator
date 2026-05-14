// OTel query endpoints — the auth-gated read side of the local trace store.
// Powers /otel-data's Overview, Traces, Operations, Logs & Errors tabs plus
// the SSE stream that feeds realtime updates. All routes are thin shims
// over otelStore methods; the heavy lifting (aggregation, percentile math,
// service-map graph construction, insight rules) lives there.

function register(app, { otelStore, docker }) {
  app.get('/api/traces', (req, res) => {
    const { service, sinceMs, untilMs, limit, q } = req.query;
    const svc = typeof service === 'string' && service ? service : undefined;
    const since = sinceMs ? Number(sinceMs) : undefined;
    const until = untilMs ? Number(untilMs) : undefined;
    const query = typeof q === 'string' && q ? q : undefined;
    // Clamp at the route layer too. otelStore.listTraces clamps to TRACE_CAP
    // internally, but with a hard upper bound here the SQL execution
    // (including the LEFT JOIN against the rollup CTEs) never sees a request
    // for an unreasonable LIMIT in the first place.
    const requested = limit ? Number(limit) : 200;
    const clampedLimit = Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 200));
    const traces = otelStore.listTraces({
      service: svc,
      sinceMs: since,
      untilMs: until,
      q: query,
      limit: clampedLimit,
    });
    res.json({ traces });
  });

  app.get('/api/traces/services', (req, res) => {
    res.json({ services: otelStore.listServices() });
  });

  app.get('/api/traces/errors', (req, res) => {
    const { limit } = req.query;
    res.json({ errors: otelStore.listErrors({ limit: limit ? Number(limit) : 200 }) });
  });

  // SSE event capture + fan-out. The ring buffer survives the brief gap
  // between a browser SSE disconnect and its auto-reconnect, so events emitted
  // during the gap can be replayed via the standard Last-Event-ID header.
  // Listeners are attached once at module init (not per-connection) so events
  // are captured even with zero clients connected. Bounded ring → bounded
  // memory; per-event monotonic ID; ring is reset on process restart (a
  // stale Last-Event-ID from a previous process is treated as a fresh
  // connect, no replay).
  const SSE_RING_CAP = 1000;
  const sseRing = [];
  const sseSubscribers = new Set();
  let sseNextId = 1;

  const sseBroadcast = (type, payload) => {
    const ev = { id: sseNextId++, type, payload };
    sseRing.push(ev);
    if (sseRing.length > SSE_RING_CAP) sseRing.shift();
    for (const sub of sseSubscribers) sub(ev);
  };
  otelStore.events.on('trace', (s) => sseBroadcast('trace', s));
  otelStore.events.on('span_error', (e) => sseBroadcast('error_record', e));
  otelStore.events.on('log', (l) => sseBroadcast('log', l));
  otelStore.events.on('trace_counts_update', (u) => sseBroadcast('trace_counts_update', u));

  // Realtime SSE. Emits trace, error_record, log, and trace_counts_update
  // events with monotonic id: values. Heartbeats every 15s keep idle
  // connections alive through proxies that drop silent sockets.
  app.get('/api/traces/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');

    // EventSource auto-sends Last-Event-ID on reconnect; allow query param as
    // a manual override for clients that can't set headers.
    const lastEventIdRaw = req.get('Last-Event-ID') || req.query.lastEventId;
    const lastEventId = lastEventIdRaw ? Number.parseInt(String(lastEventIdRaw), 10) || 0 : null;
    let highestSent = 0;
    if (lastEventId != null && lastEventId > 0 && lastEventId < sseNextId) {
      for (const ev of sseRing) {
        if (ev.id > lastEventId) {
          res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
          highestSent = ev.id;
        }
      }
    }

    // res.write throws if the underlying socket has already closed. The
    // 'close' event normally clears the heartbeat and subscriber, but it can
    // fire late behind some proxies — wrap writes and tear down on failure
    // so a stale interval doesn't keep firing against a dead stream.
    let teardown = () => {};
    const safeWrite = (chunk) => {
      try {
        res.write(chunk);
      } catch {
        teardown();
      }
    };

    const subscriber = (ev) => {
      // Skip anything we already delivered as part of the replay loop above.
      if (ev.id <= highestSent) return;
      highestSent = ev.id;
      safeWrite(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    };
    sseSubscribers.add(subscriber);

    const heartbeat = setInterval(() => {
      safeWrite(': heartbeat\n\n');
    }, 15000);

    teardown = () => {
      clearInterval(heartbeat);
      sseSubscribers.delete(subscriber);
    };
    req.on('close', teardown);
  });

  // Item 8: per-(service, root_operation) aggregates for the Operations tab.
  app.get('/api/operations', (req, res) => {
    const { sinceMs, untilMs, slowThresholdMs } = req.query;
    res.json({
      operations: otelStore.listOperations({
        sinceMs: sinceMs ? Number(sinceMs) : undefined,
        untilMs: untilMs ? Number(untilMs) : undefined,
        slowThresholdMs: slowThresholdMs ? Number(slowThresholdMs) : undefined,
      }),
    });
  });

  // Lightweight Grafana-style annotations for the Overview volume chart —
  // surface gateway-lifecycle events (last restart) as vertical markers.
  // Only emit when within the chart window so off-window restarts don't
  // float at the edges.
  const buildGatewayRestartAnnotations = async (windowMs) => {
    const annotations = [];
    try {
      const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
      const info = await docker.getContainer(targetContainer).inspect();
      const startedAt = info && info.State && info.State.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
      if (Number.isFinite(startedAt) && startedAt >= windowMs.start && startedAt <= windowMs.end) {
        annotations.push({ tsMs: startedAt, label: `${targetContainer} restarted`, tone: 'info' });
      }
    } catch { /* docker inspect non-fatal */ }
    return annotations;
  };

  // Single-round-trip aggregate powering the Overview tab — four headline
  // stats (with sparklines + delta-vs-previous-window), top services, top
  // errors. Service filter narrows the trace pool consistently with the rest
  // of the Traces API.
  app.get('/api/overview', async (req, res) => {
    const { sinceMs, untilMs, service } = req.query;
    const payload = otelStore.overview({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      service: typeof service === 'string' && service ? service : undefined,
    });
    payload.annotations = await buildGatewayRestartAnnotations(payload.windowMs);
    res.json(payload);
  });

  // Composite bundle for the Overview tab: returns everything the page needs
  // in a single round-trip — overview stats, traces histogram (+ prior window
  // for the AppD-style comparison overlay), logs histogram, heatmap, insights,
  // and service map. Replaces six separate fetches the frontend was firing in
  // lockstep on every refresh tick.
  app.get('/api/overview-bundle', async (req, res) => {
    const { sinceMs, untilMs, buckets, service, slowThresholdMs } = req.query;
    const since = sinceMs ? Number(sinceMs) : undefined;
    const until = untilMs ? Number(untilMs) : undefined;
    const svc = typeof service === 'string' && service ? service : undefined;
    const slow = slowThresholdMs ? Number(slowThresholdMs) : undefined;
    const bucketCount = buckets ? Number(buckets) : 60;
    const tracesHist = otelStore.tracesHistogram({ sinceMs: since, untilMs: until, buckets: bucketCount, service: svc, slowThresholdMs: slow });
    // Prior window = same-duration window immediately preceding the requested one.
    let priorTracesHist = null;
    if (since != null && until != null) {
      const span = until - since;
      priorTracesHist = otelStore.tracesHistogram({
        sinceMs: since - span,
        untilMs: until - span,
        buckets: bucketCount,
        service: svc,
        slowThresholdMs: slow,
      });
    }
    const overview = otelStore.overview({ sinceMs: since, untilMs: until, service: svc });
    const logsHist = otelStore.logsHistogram({ sinceMs: since, untilMs: until, buckets: bucketCount });
    const heatmap = otelStore.latencyHeatmap({
      sinceMs: since, untilMs: until,
      timeBuckets: 48, durationBuckets: 12,
      service: svc,
    });
    const insights = otelStore.insights({ sinceMs: since, untilMs: until, service: svc });
    const serviceMap = otelStore.serviceMap({ sinceMs: since, untilMs: until });

    const annotations = await buildGatewayRestartAnnotations(overview.windowMs);

    res.json({
      overview: { ...overview, annotations },
      tracesHistogram: tracesHist,
      priorTotals: priorTracesHist ? priorTracesHist.buckets.map(b => b.total || 0) : null,
      logsHistogram: logsHist,
      heatmap,
      insights,
      serviceMap,
    });
  });

  // Datadog-style service map: nodes (services that produced traces) + edges
  // (parent→child inter-service calls). Layout computed client-side.
  app.get('/api/service-map', (req, res) => {
    const { sinceMs, untilMs } = req.query;
    res.json(otelStore.serviceMap({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
    }));
  });

  // Davis-style insights: small rule-based anomaly narrator. Returns 0-3
  // short plain-English findings comparing current window vs prior. Backend
  // is intentionally simple (thresholded comparisons), not LLM-driven.
  app.get('/api/insights', (req, res) => {
    const { sinceMs, untilMs, service } = req.query;
    res.json(otelStore.insights({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      service: typeof service === 'string' && service ? service : undefined,
    }));
  });

  // 2-D heatmap: traces binned by (time, duration). Duration axis log-scaled
  // to keep the slow tail readable next to the fast bulk.
  app.get('/api/traces/latency-heatmap', (req, res) => {
    const { sinceMs, untilMs, timeBuckets, durationBuckets, service } = req.query;
    res.json(otelStore.latencyHeatmap({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      timeBuckets: timeBuckets ? Number(timeBuckets) : undefined,
      durationBuckets: durationBuckets ? Number(durationBuckets) : undefined,
      service: typeof service === 'string' && service ? service : undefined,
    }));
  });

  // Time-binned aggregates for the timeline chart on the Traces tab. Each bucket
  // reports total / ok / slow / error counts plus p50 + p95 duration in ms.
  app.get('/api/traces/histogram', (req, res) => {
    const { sinceMs, untilMs, buckets, service, slowThresholdMs } = req.query;
    res.json(otelStore.tracesHistogram({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      buckets: buckets ? Number(buckets) : undefined,
      service: typeof service === 'string' && service ? service : undefined,
      slowThresholdMs: slowThresholdMs ? Number(slowThresholdMs) : undefined,
    }));
  });

  app.get('/api/traces/:traceId', (req, res) => {
    const { traceId } = req.params;
    if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
      return res.status(400).json({ error: 'Invalid trace id' });
    }
    const trace = otelStore.getTrace(traceId.toLowerCase());
    if (!trace) return res.status(404).json({ error: 'Not found' });
    res.json(trace);
  });

  app.get('/api/logs', (req, res) => {
    const { severity, q, sinceMs, limit } = req.query;
    res.json({
      logs: otelStore.listLogs({
        severity,
        q,
        sinceMs: sinceMs ? Number(sinceMs) : undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    });
  });

  // Severity-stacked log volume buckets for the Logs / Errors timeline.
  app.get('/api/logs/histogram', (req, res) => {
    const { sinceMs, untilMs, buckets } = req.query;
    res.json(otelStore.logsHistogram({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      buckets: buckets ? Number(buckets) : undefined,
    }));
  });

  app.get('/api/logs/:traceId', (req, res) => {
    const { traceId } = req.params;
    if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
      return res.status(400).json({ error: 'Invalid trace id' });
    }
    res.json({ logs: otelStore.listLogsForTrace(traceId.toLowerCase()) });
  });
}

module.exports = { register };
