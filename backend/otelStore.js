// OTLP trace store — receives JSON-encoded OTLP/HTTP from helix-gateway's
// otlphttp/local_store exporter, persists into SQLite, and exposes a small
// query API + SSE event bus for the "View OTel Data" page.
//
// Why a separate file: index.js is already 2k+ lines of unrelated configurator
// concerns. Keeping the OTel store self-contained makes the trace pipeline
// easy to reason about (and trivial to delete if we ever swap to a real
// trace backend).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Database = require('better-sqlite3');

// Hard ceiling on retained traces — a storage safety net behind the time-based
// retention window below. Time eviction is the primary control; this only bites
// if a traffic spike packs more than this many traces into the retention
// horizon, in which case we keep the most-recent maxTraces. Overridable per
// store via the constructor's maxTraces.
const TRACE_CAP = 100_000;
// Time-based retention horizon: traces (and their spans/logs/errors) older than
// this are evicted, so the window holds "the last N hours" rather than "the
// last N traces". Default 24h; override with the TRACE_RETENTION_HOURS env var,
// or per store via the constructor's retentionMs (<=0 disables time eviction).
const TRACE_RETENTION_MS = (() => {
  const h = Number(process.env.TRACE_RETENTION_HOURS);
  return Number.isFinite(h) && h > 0 ? Math.round(h * 3_600_000) : 24 * 3_600_000;
})();
// Max rows a single listTraces / GET /api/traces call returns. Deliberately
// decoupled from retention: the store keeps a large time window for the charts
// and time-range views, but the table only ever fetches the most-recent slice
// (older traces are reachable by zooming the timeline). Keeps the list query
// fast regardless of how big the retention window grows.
const TRACE_LIST_MAX = 2000;

// Incremental-vacuum maintenance: reclaim freelist pages in small,
// non-blocking chunks during ingest-quiet windows (replaces a blocking full
// VACUUM that froze the event loop — and OTLP ingest — for the whole rewrite).
// All three are tunable.
const INC_VACUUM_PAGES = 200;           // ~800 KB/cycle at the 4 KB page size
const INC_VACUUM_INTERVAL_MS = 10_000;  // how often to attempt reclaim
const VACUUM_QUIET_MS = 2_000;          // skip if ingest landed within this window

// Services emitted by the configurator/sidecar pipeline itself. The Traces
// tab's frontend filter hides these (see frontend/src/components/otel-data/
// constants.ts:INTERNAL_SERVICES — must stay in sync), so the histogram and
// overview totals must hide them too or the chart total disagrees with the
// visible trace count.
const INTERNAL_SERVICES = [
  'helix-gateway',
  'helix-configurator',
  'helix-configurator-verify',
  'otelcol-contrib',
  // Load generator: demo scaffolding (no equivalent in a real deployment).
  // Its own client spans shouldn't appear as a monitored service.
  'traffic-generator',
];
// Log records (severity-tagged log lines) are stored separately from traces
// because OTel logs frequently arrive without a trace_id. Without a count
// cap they grew unbounded — we hit 1M+ rows / 11 GB on disk before this fix.
// 20k gives plenty of breathing room (~hour of typical OTel demo volume)
// while keeping the DB size bounded.
const LOG_CAP = 20_000;
// Span errors are usually evicted alongside their parent trace, but errors
// can arrive for trace IDs we don't see (sampling holes, propagated
// upstream span IDs) and would accumulate without bound. Cap at 5k.
const ERROR_CAP = 5_000;
// Number of points in the per-operation latency sparkline on the Operations
// tab. Small and fixed — enough to convey a trend in a ~80px-wide cell without
// bloating the /api/operations payload.
const SPARK_BUCKETS = 24;

// Bumped whenever the trace-summary derivation rule changes (e.g. the entry-span
// root rule). On startup, stored traces are re-derived once via the reconcile
// when the DB's PRAGMA user_version is below this — so a rule change re-processes
// the store only after the rule actually moves, not on every boot.
// v2: db_call_count denormalized onto the traces row (see recomputeTrace) so
// listTraces no longer scans + json_extracts the whole spans table per call.
// Bumping this backfills the column into existing traces via the reconcile path.
const TRACE_SUMMARY_RULE_VERSION = 2;

// OTLP/JSON encodes traceId/spanId as lowercase hex strings (per the OTLP
// spec post-1.0). Older builds may emit base64; tolerate both so we don't
// silently drop traces from a stale collector.
const normalizeId = (id) => {
  if (!id) return '';
  if (typeof id !== 'string') return '';
  if (/^[0-9a-fA-F]+$/.test(id)) return id.toLowerCase();
  // Base64 → hex
  try {
    return Buffer.from(id, 'base64').toString('hex');
  } catch {
    return id;
  }
};

// Pull a flat { key: value } map from OTLP attributes [{ key, value: { stringValue|intValue|... } }].
const flattenAttributes = (attrs) => {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (!a || !a.key) continue;
    const v = a.value || {};
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
    else if (v.arrayValue && Array.isArray(v.arrayValue.values)) {
      out[a.key] = v.arrayValue.values.map(vv => vv.stringValue ?? vv.intValue ?? vv.doubleValue ?? vv.boolValue);
    }
  }
  return out;
};

// OTLP body → an array of normalized spans, grouped by trace.
// We tolerate spans arriving across multiple POSTs for the same trace; each
// insert is upserted and trace-level aggregates are recomputed.
const extractSpans = (body) => {
  const out = [];
  const resourceSpans = body && body.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    const resourceAttrs = flattenAttributes(rs.resource && rs.resource.attributes);
    const serviceName = resourceAttrs['service.name'] || 'unknown_service';
    // Capture filter-grade resource attrs. service.namespace is the OTel
    // grouping convention; container.name falls back to k8s.container.name
    // (the k8sattributes processor's preferred key when running on K8s).
    // Both are stored as columns rather than buried in attributes_json so
    // filter queries don't need JSON1 extension or a full table scan.
    const serviceNamespace = resourceAttrs['service.namespace'] || null;
    const containerName =
      resourceAttrs['container.name'] ||
      resourceAttrs['k8s.container.name'] ||
      null;
    const scopeSpans = rs.scopeSpans || rs.instrumentationLibrarySpans || [];
    for (const ss of scopeSpans) {
      const spans = ss.spans || [];
      for (const s of spans) {
        const startNs = Number(s.startTimeUnixNano || 0);
        const endNs = Number(s.endTimeUnixNano || startNs);
        const attrs = flattenAttributes(s.attributes);
        const events = (s.events || []).map(ev => ({
          name: ev.name,
          timeUnixNano: Number(ev.timeUnixNano || 0),
          attributes: flattenAttributes(ev.attributes),
        }));
        out.push({
          traceId: normalizeId(s.traceId),
          spanId: normalizeId(s.spanId),
          parentSpanId: normalizeId(s.parentSpanId),
          serviceName,
          serviceNamespace,
          containerName,
          name: s.name || '',
          kind: Number(s.kind || 0),
          startTimeNs: startNs,
          endTimeNs: endNs,
          durationMs: Math.max(0, (endNs - startNs) / 1e6),
          statusCode: (s.status && Number(s.status.code)) || 0,
          statusMessage: (s.status && s.status.message) || '',
          attributes: attrs,
          events,
        });
      }
    }
  }
  return out;
};

const extractLogRecords = (body) => {
  const out = [];
  const resourceLogs = body && body.resourceLogs;
  if (!Array.isArray(resourceLogs)) return out;
  for (const rl of resourceLogs) {
    const resAttrs = flattenAttributes(rl.resource && rl.resource.attributes);
    const serviceName = resAttrs['service.name'] || 'unknown_service';
    const scopeLogs = rl.scopeLogs || rl.instrumentationLibraryLogs || [];
    for (const sl of scopeLogs) {
      for (const r of sl.logRecords || []) {
        const body = r.body || {};
        const bodyText = body.stringValue ?? body.intValue ?? body.doubleValue ?? body.boolValue ?? '';
        out.push({
          traceId: normalizeId(r.traceId),
          spanId: normalizeId(r.spanId),
          serviceName,
          severity: r.severityText || '',
          body: typeof bodyText === 'string' ? bodyText : JSON.stringify(bodyText),
          attributes: flattenAttributes(r.attributes),
          timeUnixNano: Number(r.timeUnixNano || r.observedTimeUnixNano || 0),
        });
      }
    }
  }
  return out;
};

const buildErrorRecords = (span) => {
  // Prefer exception events over the generic span.error fallback. OTel SDKs
  // commonly do BOTH when an exception is caught (record the event AND set
  // status to ERROR) — emitting both records here would double-count one
  // incident. Use the events when present; fall back to span.error only when
  // the span reports ERROR status with no exception event attached.
  const exceptionEvents = (span.events || []).filter(e => e.name === 'exception');
  if (exceptionEvents.length > 0) {
    return exceptionEvents.map(ev => ({
      traceId: span.traceId,
      spanId: span.spanId,
      serviceName: span.serviceName,
      exceptionType: ev.attributes['exception.type'] || 'exception',
      message: ev.attributes['exception.message'] || '',
      stack: ev.attributes['exception.stacktrace'] || '',
      tsNs: ev.timeUnixNano || span.endTimeNs,
    }));
  }
  if (span.statusCode === 2) {
    return [{
      traceId: span.traceId,
      spanId: span.spanId,
      serviceName: span.serviceName,
      exceptionType: 'span.error',
      message: span.statusMessage || span.name || 'Span reported error status',
      stack: '',
      tsNs: span.endTimeNs,
    }];
  }
  return [];
};

class OtelStore {
  constructor({ dbPath, retentionMs, maxTraces } = {}) {
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    this.dbPath = dbPath;
    // Retention controls — overridable per store (tests / deployment tuning).
    // retentionMs <= 0 disables time-based eviction, leaving only the count
    // ceiling; both fall back to the module defaults.
    this.retentionMs = Number.isFinite(retentionMs) ? retentionMs : TRACE_RETENTION_MS;
    this.maxTraces = Number.isFinite(maxTraces) && maxTraces > 0 ? maxTraces : TRACE_CAP;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Verify the store's integrity before trusting it. A corrupt page in the
    // spans B-tree (observed after a hard kill mid-checkpoint) makes every
    // Traces-tab query throw SqliteError "database disk image is malformed",
    // while Logs/Errors — which never read the spans table — keep working, so
    // the fault hides as a silently-empty Traces tab. Self-heal by quarantining
    // the bad file and starting fresh, rather than 500-ing on every trace query
    // until someone notices.
    this.db = this._openVerified(dbPath);
    // Incremental auto-vacuum: eviction's deletes move pages to the freelist,
    // reclaimed in small non-blocking chunks by _maybeIncrementalVacuum. Set
    // before any table is created so it applies for free on a new DB; an
    // existing DB is converted by the one-time VACUUM below.
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // Cap WAL growth. Without these, the WAL file can grow unbounded between
    // checkpoints (we hit 11 GB on disk for a 500-row dataset). 1000-page
    // autocheckpoint is the SQLite default but explicit doesn't hurt; the
    // journal_size_limit truncates the WAL back to 64 MB on each checkpoint.
    this.db.pragma('wal_autocheckpoint = 1000');
    this.db.pragma('journal_size_limit = 67108864'); // 64 MB
    // Read-path tuning: temp B-trees (GROUP BY/ORDER BY/CTEs) build in RAM;
    // ~16 MB page cache keeps the hot working set resident.
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -16000');
    this._initSchema();
    this._prepStatements();
    // Convert a pre-existing FULL/NONE database to incremental auto-vacuum.
    // The pragma above only takes effect on an existing DB after one VACUUM;
    // run it here at construct time (before app.listen) so no ingest is
    // blocked, and the DB is bounded by TRACE_CAP so it's quick.
    if (this.db.pragma('auto_vacuum', { simple: true }) !== 2) {
      try { this.db.exec('VACUUM'); }
      catch (e) { console.warn('[otelStore] auto_vacuum conversion VACUUM failed:', e.message); }
    }
    // Wall-clock of the last ingest, for the maintenance quiet-time gate.
    this._lastIngestAt = 0;
    // One-shot startup eviction — covers the case where an existing DB has
    // accumulated way past the new cap (we discovered 1M+ logs in an
    // unevicted store). Without this, a fresh code drop would have to wait
    // for the next ingest to trim.
    try { this._evictIfNeeded(); }
    catch (e) { console.warn('[otelStore] startup trace eviction failed:', e.message); }
    try { this._evictLogsIfNeeded(); }
    catch (e) { console.warn('[otelStore] startup log eviction failed:', e.message); }
    try { this._evictErrorsIfNeeded(); }
    catch (e) { console.warn('[otelStore] startup error eviction failed:', e.message); }
    // One-time migration: when the summary rule changes, re-derive existing
    // traces' columns (service / operation / has_error) once — tracked via
    // PRAGMA user_version — so they re-attribute + re-classify without waiting
    // out retention, and without re-processing the whole store on every boot.
    try {
      if (this.db.pragma('user_version', { simple: true }) < TRACE_SUMMARY_RULE_VERSION) {
        this._reconcileTraceSummaries();
        // Refresh planner statistics after a full re-derive. The store has
        // usually grown a lot by now, and listTraces' filtered plans depend on
        // sqlite_stat1 to choose index-driven (early-LIMIT) plans over full
        // scans. One-time cost, gated behind the same version bump.
        try { this.db.exec('ANALYZE'); } catch (e) { console.warn('[otelStore] ANALYZE failed:', e.message); }
        this.db.pragma(`user_version = ${TRACE_SUMMARY_RULE_VERSION}`);
      }
    } catch (e) { console.warn('[otelStore] trace-summary reconcile failed:', e.message); }
    this._startMaintenance();
  }

  // Open the SQLite store and verify it before use, returning a healthy
  // handle: the existing file if it passes a quick integrity check, otherwise
  // a freshly-created database after the corrupt files are quarantined aside.
  // quick_check is chosen over integrity_check because it's far cheaper on a
  // large store and still catches the page/B-tree corruption we hit; the store
  // is count-capped, so the check is sub-second at startup.
  _openVerified(dbPath) {
    let db;
    try {
      db = new Database(dbPath);
      const verdict = db.pragma('quick_check', { simple: true });
      if (verdict === 'ok') return db;
      console.warn(`[otelStore] integrity check failed (quick_check: ${verdict}); rebuilding store`);
    } catch (e) {
      // Either the file isn't a usable database at all, or quick_check itself
      // threw (e.g. SQLITE_NOTADB) — both mean the store can't be trusted.
      console.warn(`[otelStore] integrity check errored (${e.message}); rebuilding store`);
    }
    try { if (db) db.close(); } catch { /* already unusable */ }
    this._quarantineCorruptStore(dbPath);
    // Fresh file at the same path; _initSchema (next in the constructor)
    // recreates the tables.
    return new Database(dbPath);
  }

  // Move a corrupt store (and its -wal/-shm sidecars) aside so the next open
  // starts clean. Renamed rather than deleted so the bad file survives for
  // offline forensics; falls back to unlink if the rename can't be done, so we
  // never reopen the same corrupt file.
  _quarantineCorruptStore(dbPath) {
    const stamp = Date.now();
    for (const suffix of ['', '-wal', '-shm']) {
      const src = dbPath + suffix;
      if (!fs.existsSync(src)) continue;
      const dest = `${dbPath}.corrupt-${stamp}${suffix}`;
      try {
        fs.renameSync(src, dest);
      } catch (e) {
        console.warn(`[otelStore] could not move ${src} aside (${e.message}); deleting it instead`);
        try { fs.unlinkSync(src); } catch { /* best effort */ }
      }
    }
    console.warn(`[otelStore] corrupt store quarantined to ${dbPath}.corrupt-${stamp}*; created a fresh empty store`);
  }

  // Periodic housekeeping: force-truncate the WAL and reclaim freed pages.
  // The TRACE_CAP count cap is enforced on every insert by _evictIfNeeded;
  // those deletes leave free pages in the file that incremental_vacuum returns
  // to the OS in small chunks (see _maybeIncrementalVacuum). This replaced a
  // periodic full VACUUM, which on the synchronous driver froze the event loop
  // — and OTLP ingest — for the entire rewrite.
  _startMaintenance() {
    // Truncate WAL every 60s — cheap, keeps the WAL file from creeping.
    this._walTimer = setInterval(() => {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); }
      catch (e) { console.warn('[otelStore] WAL checkpoint failed:', e.message); }
    }, 60_000);
    // Reclaim freed pages incrementally instead of a periodic full VACUUM.
    this._incVacTimer = setInterval(() => this._maybeIncrementalVacuum(), INC_VACUUM_INTERVAL_MS);
  }

  // Return up to INC_VACUUM_PAGES freelist pages to the OS, but only when no
  // ingest has landed recently — so reclaim never adds latency to a burst.
  _maybeIncrementalVacuum() {
    if (Date.now() - this._lastIngestAt < VACUUM_QUIET_MS) return;
    // Refresh planner statistics opportunistically in the same ingest-quiet
    // window. PRAGMA optimize re-ANALYZEs only tables that changed enough to
    // matter (a cheap no-op otherwise), so listTraces' filtered plans keep
    // choosing the selective per-trace index as the store grows past whatever the
    // last ANALYZE saw — e.g. the empty fresh store created by a corruption
    // self-heal, whose stats would otherwise steer the planner into full scans.
    try { this.db.pragma('optimize'); }
    catch (e) { console.warn('[otelStore] PRAGMA optimize failed:', e.message); }
    try {
      if (!this.db.pragma('freelist_count', { simple: true })) return;
      this.db.pragma(`incremental_vacuum(${INC_VACUUM_PAGES})`);
    } catch (e) {
      console.warn('[otelStore] incremental_vacuum failed:', e.message);
    }
  }

  stopMaintenance() {
    if (this._walTimer) clearInterval(this._walTimer);
    if (this._incVacTimer) clearInterval(this._incVacTimer);
    this._walTimer = null;
    this._incVacTimer = null;
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        service_name TEXT,
        service_namespace TEXT,
        root_operation TEXT,
        start_time_ns INTEGER,
        end_time_ns INTEGER,
        duration_ms REAL,
        span_count INTEGER,
        has_error INTEGER,
        received_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_traces_received ON traces(received_at);
      CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service_name);

      CREATE TABLE IF NOT EXISTS spans (
        span_id TEXT,
        trace_id TEXT,
        parent_span_id TEXT,
        service_name TEXT,
        service_namespace TEXT,
        container_name TEXT,
        name TEXT,
        kind INTEGER,
        start_time_ns INTEGER,
        end_time_ns INTEGER,
        duration_ms REAL,
        status_code INTEGER,
        status_message TEXT,
        attributes_json TEXT,
        events_json TEXT,
        PRIMARY KEY (span_id, trace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
      -- Indexes on service_namespace/container_name are created in the
      -- backfill block below, AFTER the ALTER TABLE that adds those columns
      -- on pre-existing databases. Creating them here would fail with
      -- "no such column" because CREATE TABLE IF NOT EXISTS is a no-op
      -- when the table already exists with its older shape.

      CREATE TABLE IF NOT EXISTS span_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT,
        span_id TEXT,
        service_name TEXT,
        exception_type TEXT,
        message TEXT,
        stack TEXT,
        ts_ns INTEGER,
        received_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_errors_trace ON span_errors(trace_id);
      CREATE INDEX IF NOT EXISTS idx_errors_received ON span_errors(received_at);

      CREATE TABLE IF NOT EXISTS log_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT,
        span_id TEXT,
        service_name TEXT,
        severity TEXT,
        body TEXT,
        attributes_json TEXT,
        ts_ns INTEGER,
        received_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_logs_trace ON log_records(trace_id);
      CREATE INDEX IF NOT EXISTS idx_logs_received ON log_records(received_at);
    `);

    // Backfill columns on databases created before service.namespace /
    // container.name landed. SQLite doesn't have ADD COLUMN IF NOT EXISTS,
    // so we attempt and swallow the "duplicate column" error. Pre-existing
    // rows get NULL — fine, the filter UI treats NULL as "no filter" and
    // upcoming ingests populate the new columns going forward.
    const addColumn = (table, column, type) => {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
      catch (e) {
        if (!/duplicate column name/i.test(e.message || '')) throw e;
      }
    };
    addColumn('spans', 'service_namespace', 'TEXT');
    addColumn('spans', 'container_name', 'TEXT');
    // traces.service_namespace is denormalized from the root span (below) so
    // the trace summary — and the "View in Helix" deep-link built from it —
    // can scope to the namespace the trace actually lives in. Pre-existing
    // rows get NULL until their next ingest recomputes the summary.
    addColumn('traces', 'service_namespace', 'TEXT');
    // db_call_count is denormalized from the trace's spans (counted once in
    // recomputeTrace) so listTraces doesn't scan + json_extract the entire spans
    // table on every call just to badge DB activity — that full scan dominated
    // the trace-list query as the store grew. Backfilled via the version bump.
    addColumn('traces', 'db_call_count', 'INTEGER');
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_spans_namespace ON spans(service_namespace)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_spans_container ON spans(container_name)'); } catch {}
    // idx_spans_service serves service-only lookups (listServices, filter values).
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_spans_service ON spans(service_name)'); } catch {}
    // The trace-list service filter (EXISTS) and per-service entry-span subqueries
    // key on trace_id FIRST (highly selective) so they seek one trace's spans
    // rather than scanning every span of a service — the dominant 'frontend'
    // service is ~all of them. Crucially, with empty planner stats (e.g. a fresh
    // store right after a self-heal) SQLite would otherwise pick idx_spans_service
    // and scan ~all spans per result row (measured: ~1.5s on a 72k-span store).
    // This composite covers the WHERE (trace_id, service_name) AND the ORDER BY
    // (start_time_ns, span_id), so the planner picks it regardless of stats — it
    // both narrows by trace_id and avoids the sort.
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_spans_trace_svc ON spans(trace_id, service_name, start_time_ns, span_id)'); } catch {}
  }

  _prepStatements() {
    this.upsertSpan = this.db.prepare(`
      INSERT INTO spans (span_id, trace_id, parent_span_id, service_name,
                          service_namespace, container_name, name, kind,
                          start_time_ns, end_time_ns, duration_ms, status_code, status_message,
                          attributes_json, events_json)
      VALUES (@spanId, @traceId, @parentSpanId, @serviceName,
              @serviceNamespace, @containerName, @name, @kind,
              @startTimeNs, @endTimeNs, @durationMs, @statusCode, @statusMessage,
              @attributesJson, @eventsJson)
      ON CONFLICT(span_id, trace_id) DO UPDATE SET
        parent_span_id = excluded.parent_span_id,
        service_name = excluded.service_name,
        service_namespace = excluded.service_namespace,
        container_name = excluded.container_name,
        name = excluded.name,
        kind = excluded.kind,
        start_time_ns = excluded.start_time_ns,
        end_time_ns = excluded.end_time_ns,
        duration_ms = excluded.duration_ms,
        status_code = excluded.status_code,
        status_message = excluded.status_message,
        attributes_json = excluded.attributes_json,
        events_json = excluded.events_json
    `);
    this.recomputeTrace = this.db.prepare(`
      INSERT INTO traces (trace_id, service_name, service_namespace, root_operation, start_time_ns, end_time_ns,
                          duration_ms, span_count, has_error, db_call_count, received_at)
      WITH root_span AS (
        -- The trace's ENTRY span — the app's view of where the request enters.
        -- Preference: (1) the earliest SERVER span (kind=2), the real entry
        -- point, so an upstream CLIENT span (a load generator, API gateway, RUM
        -- beacon) can't hijack the trace's service / operation / outcome; then
        -- (2) the earliest truly-parentless or dangling-parent (orphaned) span;
        -- then (3) the earliest span of all. Resolved once so service /
        -- namespace / operation / has_error all come from the same span.
        SELECT service_name, service_namespace, name, status_code FROM spans s
        WHERE trace_id = @traceId
        ORDER BY
          (kind = 2) DESC,
          (parent_span_id IS NULL OR parent_span_id = ''
            OR NOT EXISTS (SELECT 1 FROM spans p WHERE p.trace_id = s.trace_id AND p.span_id = s.parent_span_id)) DESC,
          start_time_ns ASC
        LIMIT 1
      )
      SELECT
        @traceId,
        COALESCE((SELECT service_name FROM root_span),
                 (SELECT service_name FROM spans WHERE trace_id = @traceId ORDER BY start_time_ns ASC LIMIT 1)),
        COALESCE((SELECT service_namespace FROM root_span),
                 (SELECT service_namespace FROM spans WHERE trace_id = @traceId ORDER BY start_time_ns ASC LIMIT 1)),
        COALESCE((SELECT name FROM root_span),
                 (SELECT name FROM spans WHERE trace_id = @traceId ORDER BY start_time_ns ASC LIMIT 1)),
        (SELECT MIN(start_time_ns) FROM spans WHERE trace_id = @traceId),
        (SELECT MAX(end_time_ns) FROM spans WHERE trace_id = @traceId),
        (SELECT (MAX(end_time_ns) - MIN(start_time_ns)) / 1e6 FROM spans WHERE trace_id = @traceId),
        (SELECT COUNT(*) FROM spans WHERE trace_id = @traceId),
        -- has_error = the trace OUTCOME: did the root/entry span fail? NOT "any
        -- span anywhere errored". Handled/retried downstream failures (e.g. a
        -- retried Redis lookup inside an otherwise-successful request) stay
        -- visible via error_count + the in-trace error pills, but don't flag the
        -- whole trace as an error.
        COALESCE((SELECT CASE WHEN status_code >= 2 THEN 1 ELSE 0 END FROM root_span), 0),
        -- db_call_count: spans in THIS trace carrying a db.system(.name) attr,
        -- counted once here (scoped to the trace via idx_spans_trace) instead of
        -- scanning + json_extracting the whole spans table per listTraces call.
        (SELECT COUNT(*) FROM spans WHERE trace_id = @traceId
           AND (json_extract(attributes_json, '$."db.system"') IS NOT NULL
                OR json_extract(attributes_json, '$."db.system.name"') IS NOT NULL)),
        @receivedAt
      ON CONFLICT(trace_id) DO UPDATE SET
        service_name = excluded.service_name,
        service_namespace = excluded.service_namespace,
        root_operation = excluded.root_operation,
        start_time_ns = excluded.start_time_ns,
        end_time_ns = excluded.end_time_ns,
        duration_ms = excluded.duration_ms,
        span_count = excluded.span_count,
        has_error = excluded.has_error,
        db_call_count = excluded.db_call_count,
        received_at = excluded.received_at
    `);
    this.insertError = this.db.prepare(`
      INSERT INTO span_errors (trace_id, span_id, service_name, exception_type, message, stack,
                                ts_ns, received_at)
      VALUES (@traceId, @spanId, @serviceName, @exceptionType, @message, @stack, @tsNs, @receivedAt)
    `);
    this.insertLog = this.db.prepare(`
      INSERT INTO log_records (trace_id, span_id, service_name, severity, body, attributes_json,
                                ts_ns, received_at)
      VALUES (@traceId, @spanId, @serviceName, @severity, @body, @attributesJson, @tsNs, @receivedAt)
    `);
    this.countTraces = this.db.prepare(`SELECT COUNT(*) AS n FROM traces`);
    this.oldestTraceIds = this.db.prepare(
      `SELECT trace_id FROM traces ORDER BY received_at ASC LIMIT ?`
    );
    // Traces older than a cutoff received_at — drives time-based retention.
    // Uses idx_traces_received, so it's an indexed range scan (a no-op when
    // nothing has aged out).
    this.expiredTraceIds = this.db.prepare(
      `SELECT trace_id FROM traces WHERE received_at < ?`
    );
    this.deleteSpansForTrace = this.db.prepare(`DELETE FROM spans WHERE trace_id = ?`);
    this.deleteErrorsForTrace = this.db.prepare(`DELETE FROM span_errors WHERE trace_id = ?`);
    // Span re-ingestion: spans are upserted by (trace_id, span_id), but
    // span_errors had no unique key. Clear errors per span before re-emit so
    // a retry doesn't pile up duplicate rows for the same incident.
    this.deleteErrorsForSpan = this.db.prepare(`DELETE FROM span_errors WHERE trace_id = ? AND span_id = ?`);
    this.deleteLogsForTrace = this.db.prepare(`DELETE FROM log_records WHERE trace_id = ?`);
    this.deleteTrace = this.db.prepare(`DELETE FROM traces WHERE trace_id = ?`);
    this.selectTraceSummary = this.db.prepare(`SELECT * FROM traces WHERE trace_id = ?`);
  }

  ingestSpans(rawSpans) {
    if (!rawSpans || !rawSpans.length) return [];
    const now = Date.now();
    this._lastIngestAt = now;
    const touchedTraces = new Set();
    const summaries = [];
    const errorEvents = [];

    const tx = this.db.transaction(() => {
      for (const span of rawSpans) {
        if (!span.traceId || !span.spanId) continue;
        this.upsertSpan.run({
          spanId: span.spanId,
          traceId: span.traceId,
          parentSpanId: span.parentSpanId || '',
          serviceName: span.serviceName,
          // null-coalesce so spans extracted before this change (or upstream
          // payloads with no resource attrs) bind cleanly to TEXT columns.
          serviceNamespace: span.serviceNamespace ?? null,
          containerName: span.containerName ?? null,
          name: span.name,
          kind: span.kind,
          startTimeNs: span.startTimeNs,
          endTimeNs: span.endTimeNs,
          durationMs: span.durationMs,
          statusCode: span.statusCode,
          statusMessage: span.statusMessage,
          attributesJson: JSON.stringify(span.attributes || {}),
          eventsJson: JSON.stringify(span.events || []),
        });
        touchedTraces.add(span.traceId);

        // Replace this span's existing error rows on every ingest so retries
        // don't duplicate. Cheap — index on (trace_id) covers the lookup.
        this.deleteErrorsForSpan.run(span.traceId, span.spanId);
        for (const err of buildErrorRecords(span)) {
          this.insertError.run({ ...err, receivedAt: now });
          errorEvents.push({ ...err, receivedAt: now });
        }
      }
      for (const traceId of touchedTraces) {
        this.recomputeTrace.run({ traceId, receivedAt: now });
        summaries.push(this.selectTraceSummary.get(traceId));
      }
      this._evictIfNeeded();
      this._evictErrorsIfNeeded();
    });
    tx();

    // One participant-list query covers both jobs: (a) skip self-only
    // pipeline traces so synthetic verify/etc. don't appear in the live
    // list, and (b) annotate the emitted summary with its participating
    // services so the frontend can honor an active service filter when
    // merging SSE events (otherwise long-lived traces from other services
    // bypass the filter and dominate the list).
    const getParticipants = this.db.prepare(
      `SELECT DISTINCT service_name FROM spans
         WHERE trace_id = ? AND service_name IS NOT NULL`,
    );
    // Same idea for namespace + container so the frontend can client-side
    // gate the SSE merge against an active namespace/container filter.
    // Without these, turning on the namespace filter would freeze the live
    // feed (or worse, leak in traces from the wrong namespace) until the
    // 30s polling fallback caught up.
    const getParticipantNamespaces = this.db.prepare(
      `SELECT DISTINCT service_namespace FROM spans
         WHERE trace_id = ? AND service_namespace IS NOT NULL`,
    );
    const getParticipantContainers = this.db.prepare(
      `SELECT DISTINCT container_name FROM spans
         WHERE trace_id = ? AND container_name IS NOT NULL`,
    );
    for (const summary of summaries) {
      if (!summary) continue;
      const participants = getParticipants.all(summary.trace_id).map(r => r.service_name);
      if (!participants.some(s => !INTERNAL_SERVICES.includes(s))) continue;
      const participating_namespaces = getParticipantNamespaces.all(summary.trace_id).map(r => r.service_namespace);
      const participating_containers = getParticipantContainers.all(summary.trace_id).map(r => r.container_name);
      this.events.emit('trace', {
        ...summary,
        participating_services: participants,
        participating_namespaces,
        participating_containers,
      });
    }
    for (const err of errorEvents) {
      // Note: NOT 'error' — that's a reserved EventEmitter channel that
      // throws when emitted with no listeners.
      this.events.emit('span_error', err);
    }
    // Item 10: re-emit fresh rollup counts so trace rows that already exist
    // in the client list stop showing 0 when more spans/errors land.
    for (const traceId of touchedTraces) {
      this._emitTraceCountsUpdate(traceId);
    }
    return summaries;
  }

  ingestLogs(rawLogs) {
    if (!rawLogs || !rawLogs.length) return 0;
    const now = Date.now();
    this._lastIngestAt = now;
    const touchedTraces = new Set();
    const tx = this.db.transaction(() => {
      for (const log of rawLogs) {
        this.insertLog.run({
          traceId: log.traceId || '',
          spanId: log.spanId || '',
          serviceName: log.serviceName,
          severity: log.severity,
          body: log.body,
          attributesJson: JSON.stringify(log.attributes || {}),
          tsNs: log.timeUnixNano,
          receivedAt: now,
        });
        if (log.traceId) touchedTraces.add(log.traceId);
      }
      this._evictLogsIfNeeded();
    });
    tx();
    for (const log of rawLogs) {
      this.events.emit('log', { ...log, receivedAt: now });
    }
    for (const traceId of touchedTraces) {
      this._emitTraceCountsUpdate(traceId);
    }
    return rawLogs.length;
  }

  // Distinct OTel namespaces seen in stored traces, with trace counts and the
  // most-recent receipt time. Null namespace = un-namespaced traces (the route
  // maps those to X_SOURCE). Ordered newest-seen first for the Detect UI.
  listNamespaces() {
    const rows = this.db.prepare(`
      SELECT service_namespace AS namespace,
             COUNT(*)          AS traceCount,
             MAX(received_at)  AS lastSeen
      FROM traces
      GROUP BY service_namespace
      ORDER BY lastSeen DESC, namespace ASC
    `).all();
    return rows.map((r) => ({ namespace: r.namespace == null ? null : String(r.namespace), traceCount: r.traceCount, lastSeen: r.lastSeen }));
  }

  // Item 10: compute and broadcast fresh rollup counts for a trace. Cheap
  // (three indexed-by-trace_id COUNT queries), but skip when the trace
  // doesn't exist yet — the 'trace' event itself triggers the initial row.
  _emitTraceCountsUpdate(traceId) {
    if (!traceId || !this.selectTraceSummary.get(traceId)) return;
    const counts = this.getTraceCounts(traceId);
    this.events.emit('trace_counts_update', { traceId, ...counts });
  }

  getTraceCounts(traceId) {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM log_records WHERE trace_id = ?) AS log_count,
        (SELECT COUNT(*) FROM span_errors WHERE trace_id = ?) AS error_count,
        (SELECT COUNT(*) FROM spans
           WHERE trace_id = ?
             AND (json_extract(attributes_json, '$."db.system"') IS NOT NULL
               OR json_extract(attributes_json, '$."db.system.name"') IS NOT NULL)
        ) AS db_call_count
    `).get(traceId, traceId, traceId);
    return row || { log_count: 0, error_count: 0, db_call_count: 0 };
  }

  // Item 8: per-(service, root_operation) aggregates over the time window.
  // Computes p50/p95 from raw durations in JS — the trace cap (500) keeps
  // the result set small enough that a sort-and-index is faster than wiring
  // SQLite window functions.
  listOperations({ sinceMs, untilMs, slowThresholdMs, namespace, container, service } = {}) {
    const SLOW_MS = Number.isFinite(slowThresholdMs) && slowThresholdMs > 0 ? slowThresholdMs : 1000;
    const params = [];
    const where = [];
    if (sinceMs) { where.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('received_at <= ?'); params.push(untilMs); }
    // Service/namespace/container are span-level participation filters, same
    // shape as listTraces: a trace (and therefore its root-operation row) is
    // included if ANY of its spans matches. Service scopes the Operations tab
    // to the traffic the filtered service took part in, consistent with how
    // the page's namespace/container filters already narrow this rollup.
    if (service) {
      where.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
      params.push(service);
    }
    if (namespace) {
      where.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
      params.push(namespace);
    }
    if (container) {
      where.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
      params.push(container);
    }
    const sql = `SELECT service_name, root_operation, duration_ms, has_error, received_at
                 FROM traces ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const rows = this.db.prepare(sql).all(...params);
    // Concrete window for the per-operation latency sparkline. Mirrors
    // tracesHistogram's default (last hour → now) when the caller didn't pin
    // an explicit window, so the trend axis lines up with the timeline chart.
    const now = Date.now();
    // When no window is pinned (the "All" range), span the sparkline across the
    // actual data — earliest stored trace → now — so the trend matches the
    // all-time aggregates beside it instead of silently showing only the last
    // hour. Falls back to last-hour when the store is empty.
    const sparkStart = Number.isFinite(sinceMs) ? Number(sinceMs) : (this.earliestReceivedAt('traces') ?? now - 60 * 60 * 1000);
    const sparkEnd = Number.isFinite(untilMs) ? Number(untilMs) : now;
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.service_name || ''}|${r.root_operation || ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          service_name: r.service_name || '',
          root_operation: r.root_operation || '',
          durations: [],
          samples: [],
          error_count: 0,
          slow_count: 0,
          satisfied_count: 0,
          tolerating_count: 0,
        };
        groups.set(key, g);
      }
      g.durations.push(r.duration_ms);
      g.samples.push({ ts: r.received_at, dur: r.duration_ms });
      if (r.has_error) {
        g.error_count += 1;
      } else {
        if (r.duration_ms <= SLOW_MS) {
          g.satisfied_count += 1;
        } else if (r.duration_ms <= 4 * SLOW_MS) {
          g.tolerating_count += 1;
        }
      }
      if (r.duration_ms > SLOW_MS) g.slow_count += 1;
    }
    const percentile = (sorted, p) => {
      if (sorted.length === 0) return 0;
      // Nearest-rank: idx = ceil(p*n) - 1, clamped. Same formula as
      // computePercentiles (histogram/overview) so every rollup agrees, and so
      // a small-N operation's p95 still surfaces its slow tail instead of
      // collapsing toward the median.
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
      return sorted[idx];
    };
    return Array.from(groups.values()).map(g => {
      const sorted = g.durations.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const satisfied = g.satisfied_count;
      const tolerating = g.tolerating_count;
      const apdex = sorted.length ? (satisfied + 0.5 * tolerating) / sorted.length : 1.0;
      return {
        service_name: g.service_name,
        root_operation: g.root_operation,
        trace_count: sorted.length,
        avg_ms: sorted.length ? sum / sorted.length : 0,
        min_ms: sorted[0] || 0,
        max_ms: sorted[sorted.length - 1] || 0,
        p50_ms: percentile(sorted, 0.5),
        p95_ms: percentile(sorted, 0.95),
        error_count: g.error_count,
        slow_count: g.slow_count,
        apdex,
        sparkline: latencySparkline(g.samples, sparkStart, sparkEnd, SPARK_BUCKETS),
      };
    }).sort((a, b) => b.trace_count - a.trace_count);
  }

  // Per-(service, operation) latency percentiles computed from individual
  // spans — NOT trace roots like listOperations. This is the p95 baseline the
  // Traces tab's Outlier filter/badge needs when a Service filter is active:
  // each row then shows a *participating* service's entry span (the svc_*
  // fields listTraces attaches), whose operation — e.g. cart-api|GET /cart/items
  // — never appears in listOperations because app services are rarely trace
  // roots (the load generator roots every trace in the demo). Spans carry no
  // received_at, so the window is applied through the owning trace's
  // received_at. p50/p95 use the same nearest-rank percentile as listOperations
  // so the two rollups agree where they overlap (root spans). Assumes a
  // service emits one server span per operation per trace, so grouping all
  // spans by (service, name) tracks the entry-span population listTraces shows.
  listOperationLatencies({ sinceMs, untilMs, namespace, container } = {}) {
    const traceWhere = [];
    const params = [];
    if (sinceMs) { traceWhere.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { traceWhere.push('received_at <= ?'); params.push(untilMs); }
    // Namespace/container are span-level resource attrs; scope by trace
    // participation, same shape as listOperations / listTraces.
    if (namespace) {
      traceWhere.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
      params.push(namespace);
    }
    if (container) {
      traceWhere.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
      params.push(container);
    }
    const sql = `SELECT s.service_name, s.name AS operation, s.duration_ms
                 FROM spans s
                 WHERE s.trace_id IN (SELECT trace_id FROM traces${traceWhere.length ? ' WHERE ' + traceWhere.join(' AND ') : ''})`;
    const rows = this.db.prepare(sql).all(...params);
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.service_name || ''}|${r.operation || ''}`;
      let g = groups.get(key);
      if (!g) {
        g = { service_name: r.service_name || '', operation: r.operation || '', durations: [] };
        groups.set(key, g);
      }
      g.durations.push(r.duration_ms);
    }
    const percentile = (sorted, p) => {
      if (sorted.length === 0) return 0;
      // Nearest-rank: idx = ceil(p*n) - 1, clamped. Same formula as
      // computePercentiles (histogram/overview) so every rollup agrees, and so
      // a small-N operation's p95 still surfaces its slow tail instead of
      // collapsing toward the median.
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
      return sorted[idx];
    };
    return Array.from(groups.values()).map(g => {
      const sorted = g.durations.slice().sort((a, b) => a - b);
      return {
        service_name: g.service_name,
        operation: g.operation,
        count: sorted.length,
        p50_ms: percentile(sorted, 0.5),
        p95_ms: percentile(sorted, 0.95),
      };
    }).sort((a, b) => b.p95_ms - a.p95_ms);
  }

  recentThroughput(windowMs = 3_600_000) {
    const sinceMs = Date.now() - windowMs;
    // spans has no received_at column — count via traces.received_at and
    // sum the span_count rollup that ingestion already maintains. Lets us
    // measure "spans received in the last hour" without joining the spans
    // table on every call.
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(span_count), 0) AS total FROM traces WHERE received_at >= ?'
    ).get(sinceMs);
    const totalSpans = row?.total || 0;
    const spansPerSec = totalSpans / (windowMs / 1000);
    return { totalSpans, spansPerSec, windowMs };
  }

  // Re-derive every stored trace's root columns (service / namespace / operation
  // / has_error) by re-running recomputeTrace — the single source of truth for
  // the entry-span rule — preserving each trace's original received_at. So when
  // the rule changes (e.g. client-rooting → SERVER-rooting), existing traces
  // re-attribute and re-classify on the next boot instead of aging out. Reusing
  // recomputeTrace means the reconcile can't drift from ingest. Idempotent.
  _reconcileTraceSummaries() {
    const rows = this.db.prepare('SELECT trace_id AS traceId, received_at AS receivedAt FROM traces').all();
    const run = this.db.transaction((list) => {
      for (const r of list) this.recomputeTrace.run(r);
    });
    run(rows);
  }

  // Drop a trace and everything hanging off it (spans, errors, logs).
  _deleteTraceCascade(traceId) {
    this.deleteSpansForTrace.run(traceId);
    this.deleteErrorsForTrace.run(traceId);
    this.deleteLogsForTrace.run(traceId);
    this.deleteTrace.run(traceId);
  }

  _evictIfNeeded() {
    // Primary retention is time-based: drop anything older than the horizon so
    // the window holds "the last N hours", not "the last N traces". Indexed
    // range scan — a no-op when nothing has aged out.
    if (this.retentionMs > 0) {
      const cutoff = Date.now() - this.retentionMs;
      const expired = this.expiredTraceIds.all(cutoff).map(r => r.trace_id);
      for (const traceId of expired) this._deleteTraceCascade(traceId);
    }
    // Safety net: a hard count ceiling so a burst inside the horizon can't grow
    // the store unbounded. Normally a no-op — time eviction keeps the count low.
    const { n } = this.countTraces.get();
    if (n <= this.maxTraces) return;
    const overflow = n - this.maxTraces;
    const victims = this.oldestTraceIds.all(overflow).map(r => r.trace_id);
    for (const traceId of victims) this._deleteTraceCascade(traceId);
  }

  // Eviction for the standalone log records table. Trace eviction only drops
  // logs tied to evicted traces — orphan logs (no trace_id, or trace_id we
  // never saw spans for) accumulate without bound otherwise. We saw 1M+
  // rows / 11 GB on disk before this cap was added.
  _evictLogsIfNeeded() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM log_records').get();
    if (!row || row.n <= LOG_CAP) return;
    const overflow = row.n - LOG_CAP;
    this.db.prepare(
      `DELETE FROM log_records WHERE id IN (
         SELECT id FROM log_records ORDER BY received_at ASC, id ASC LIMIT ?
       )`,
    ).run(overflow);
  }

  // Same idea for span_errors. Errors for traces we tracked get evicted with
  // their parent trace; errors that arrive for unseen trace IDs accumulate.
  _evictErrorsIfNeeded() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM span_errors').get();
    if (!row || row.n <= ERROR_CAP) return;
    const overflow = row.n - ERROR_CAP;
    this.db.prepare(
      `DELETE FROM span_errors WHERE id IN (
         SELECT id FROM span_errors ORDER BY received_at ASC, id ASC LIMIT ?
       )`,
    ).run(overflow);
  }

  listTraces({ service, namespace, container, sinceMs, untilMs, q, limit = 200 }) {
    const params = [];
    const where = [];
    // Filter by participant, not just by root service. Otherwise services
    // that only appear as downstream callees (checkout/payment/email/etc in
    // the OTel demo, where load-generator starts every trace) are invisible.
    // EXISTS (not `trace_id IN (SELECT …)`) so the planner drives the outer
    // query from idx_traces_received (newest-first) and early-stops at LIMIT,
    // probing each candidate trace with an indexed per-trace lookup — instead of
    // materializing + sorting every matching trace_id, which for the dominant
    // service is ~the whole store. A trace matches if ANY span carries the
    // requested service / namespace / container.
    if (service) {
      where.push('EXISTS (SELECT 1 FROM spans sf WHERE sf.trace_id = t.trace_id AND sf.service_name = ?)');
      params.push(service);
    }
    if (namespace) {
      where.push('EXISTS (SELECT 1 FROM spans sf WHERE sf.trace_id = t.trace_id AND sf.service_namespace = ?)');
      params.push(namespace);
    }
    if (container) {
      where.push('EXISTS (SELECT 1 FROM spans sf WHERE sf.trace_id = t.trace_id AND sf.container_name = ?)');
      params.push(container);
    }
    if (sinceMs) { where.push('t.received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('t.received_at <= ?'); params.push(untilMs); }
    // Search across root_operation, service_name (root), and trace_id.
    // Runs server-side so it queries the full window — otherwise traces
    // matching the search but past the LIMIT cap are invisible.
    if (q && typeof q === 'string' && q.trim()) {
      const needle = `%${q.trim().toLowerCase()}%`;
      where.push('(LOWER(t.root_operation) LIKE ? OR LOWER(t.service_name) LIKE ? OR LOWER(t.trace_id) LIKE ?)');
      params.push(needle, needle, needle);
    }
    // Drop traces that are *entirely* internal-service pipeline self-telemetry
    // (cheap to compute since spans is indexed on trace_id). Filtering on
    // t.service_name (the root) instead would silently hide real app traces
    // in pipelines that re-root every forwarded trace at helix-gateway.
    where.push(`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.trace_id
                        AND s.service_name NOT IN (${INTERNAL_SERVICES.map(() => '?').join(',')}))`);
    params.push(...INTERNAL_SERVICES);
    // log/error counts stay as CTE LEFT JOINs (lc/ec) — small tables, cheap. The
    // db-call count is now read from the denormalized traces.db_call_count column
    // (computed once in recomputeTrace), replacing a `dc` CTE that scanned +
    // json_extracted the ENTIRE spans table on every call.
    //
    // When a service is selected, surface that service's *entry span* per trace —
    // its earliest span (top-level/server operation) — so the row reads from the
    // selected service's perspective instead of the trace root (the load
    // generator in the demo). Computed as correlated subqueries over the ≤LIMIT
    // result rows (each scoped to one trace via idx_spans_trace + idx_spans_service)
    // rather than a ROW_NUMBER() window over EVERY span of that service, which
    // scanned + sorted ~1.5M rows for the dominant service. The four subqueries
    // share one entry span (same ORDER BY … LIMIT 1); their placeholders sit in
    // the SELECT list (before WHERE), so their binds are prepended via svcHeadParams.
    const svcEntry = (col) =>
      `(SELECT ${col} FROM spans se WHERE se.trace_id = t.trace_id AND se.service_name = ?
         ORDER BY se.start_time_ns ASC, se.span_id ASC LIMIT 1)`;
    const svcSelect = service
      ? `, ${svcEntry('se.name')} AS svc_operation`
        + `, ${svcEntry('se.duration_ms')} AS svc_duration_ms`
        + `, ${svcEntry('se.status_code')} AS svc_status_code`
        + `, ${svcEntry('se.start_time_ns')} AS svc_start_ns`
      : '';
    const svcHeadParams = service ? [service, service, service, service] : [];
    const sql = `
      WITH lc AS (SELECT trace_id, COUNT(*) AS c FROM log_records GROUP BY trace_id),
           ec AS (SELECT trace_id, COUNT(*) AS c FROM span_errors GROUP BY trace_id)
      SELECT
        t.*,
        COALESCE(lc.c, 0) AS log_count,
        COALESCE(ec.c, 0) AS error_count,
        COALESCE(
          (SELECT s.name FROM span_errors e
             JOIN spans s ON s.trace_id = e.trace_id AND s.span_id = e.span_id
            WHERE e.trace_id = t.trace_id AND e.exception_type <> 'span.error'
            ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1),
          (SELECT s.name FROM spans s
            WHERE s.trace_id = t.trace_id AND s.status_code >= 2
            ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1)
        ) AS failing_operation,
        COALESCE(
          (SELECT s.service_name FROM span_errors e
             JOIN spans s ON s.trace_id = e.trace_id AND s.span_id = e.span_id
            WHERE e.trace_id = t.trace_id AND e.exception_type <> 'span.error'
            ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1),
          (SELECT s.service_name FROM spans s
            WHERE s.trace_id = t.trace_id AND s.status_code >= 2
            ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1)
        ) AS failing_service,
        (SELECT group_concat(DISTINCT service_name) FROM spans WHERE trace_id = t.trace_id AND service_name IS NOT NULL AND service_name <> '') AS participating_services,
        (SELECT s.name FROM spans s WHERE s.trace_id = t.trace_id AND s.name <> t.root_operation AND s.parent_span_id IS NOT NULL AND s.parent_span_id <> '' ORDER BY s.duration_ms DESC, s.span_id DESC LIMIT 1) AS slowest_child_operation,
        (SELECT s.service_name FROM spans s WHERE s.trace_id = t.trace_id AND s.name <> t.root_operation AND s.parent_span_id IS NOT NULL AND s.parent_span_id <> '' ORDER BY s.duration_ms DESC, s.span_id DESC LIMIT 1) AS slowest_child_service,
        (SELECT s.duration_ms FROM spans s WHERE s.trace_id = t.trace_id AND s.name <> t.root_operation AND s.parent_span_id IS NOT NULL AND s.parent_span_id <> '' ORDER BY s.duration_ms DESC, s.span_id DESC LIMIT 1) AS slowest_child_duration_ms${svcSelect}
      FROM traces t
      LEFT JOIN lc ON lc.trace_id = t.trace_id
      LEFT JOIN ec ON ec.trace_id = t.trace_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.received_at DESC LIMIT ?
    `;
    params.push(Math.min(Math.max(1, limit | 0), TRACE_LIST_MAX));
    // svcHeadParams binds the entry-span subqueries in the SELECT list, which
    // precede every WHERE placeholder in the SQL text.
    const rows = this.db.prepare(sql).all(...svcHeadParams, ...params);
    return rows.map(r => ({
      ...r,
      db_call_count: r.db_call_count ?? 0,
      participating_services: r.participating_services ? r.participating_services.split(',') : []
    }));
  }

  getTrace(traceId) {
    const summary = this.selectTraceSummary.get(traceId);
    if (!summary) return null;
    const rawSpans = this.db.prepare(
      `SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ns ASC`
    ).all(traceId);
    const spans = rawSpans.map(s => ({
      spanId: s.span_id,
      traceId: s.trace_id,
      parentSpanId: s.parent_span_id || null,
      serviceName: s.service_name,
      name: s.name,
      kind: s.kind,
      startTimeNs: s.start_time_ns,
      endTimeNs: s.end_time_ns,
      durationMs: s.duration_ms,
      statusCode: s.status_code,
      statusMessage: s.status_message,
      attributes: safeJson(s.attributes_json, {}),
      events: safeJson(s.events_json, []),
    }));
    return { summary, spans };
  }

  // Distinct values for the OtelData filter UI dropdowns. Returns just the
  // set of values we've seen — the dropdowns treat empty/missing as "no
  // filter applied" and don't render NULL as an option. Same lifetime
  // semantics as listServices(): no time window, so the dropdown stays
  // useful while the workload is paused or quiet.
  //
  // Intentionally NOT narrowed by service: the Service dropdown narrows by
  // namespace+container (see listServices), but the reverse direction was a
  // UX trap. Many services (notably Jaeger HotROD-style demos) don't emit a
  // service.namespace at all — picking one would shrink the Namespace
  // dropdown's options to empty and leave the user without a way to clear
  // or change their namespace filter. Keeping these lifetime gives a stable
  // anchor.
  listFilterValues() {
    const namespaces = this.db.prepare(
      `SELECT DISTINCT service_namespace AS v FROM spans
       WHERE service_namespace IS NOT NULL AND service_namespace != ''
       ORDER BY service_namespace ASC`
    ).all().map(r => r.v);
    const containers = this.db.prepare(
      `SELECT DISTINCT container_name AS v FROM spans
       WHERE container_name IS NOT NULL AND container_name != ''
       ORDER BY container_name ASC`
    ).all().map(r => r.v);
    return { namespaces, containers };
  }

  listServices({ namespace, container } = {}) {
    // Lifetime counts — not windowed. Earlier attempt at windowing made the
    // dropdown empty whenever the user paused or their workload went quiet,
    // because the spans table had no rows in the recent window even though
    // the chart still showed frozen data. The dropdown is a service picker;
    // it should always offer the services that have ever sent traces. Counts
    // are best-effort and may overstate "currently active" — that's a known
    // trade-off, less bad than a vanishing dropdown.
    //
    // namespace/container narrow the list to services that have emitted at
    // least one span tagged with those resource attrs — so picking a
    // namespace in the top bar shrinks the Service dropdown to just the
    // services that participate in that namespace.
    const params = [];
    const where = ['s.service_name IS NOT NULL'];
    where.push(`s.service_name NOT IN (${INTERNAL_SERVICES.map(() => '?').join(',')})`);
    params.push(...INTERNAL_SERVICES);
    if (namespace) { where.push('s.service_namespace = ?'); params.push(namespace); }
    if (container) { where.push('s.container_name = ?');    params.push(container); }
    const sql = `SELECT s.service_name AS name, COUNT(DISTINCT s.trace_id) AS traceCount
                 FROM spans s
                 WHERE ${where.join(' AND ')}
                 GROUP BY s.service_name ORDER BY s.service_name ASC`;
    return this.db.prepare(sql).all(...params);
  }

  listErrors({ sinceMs, untilMs, limit = 200 } = {}) {
    const params = [];
    const where = [];
    if (sinceMs) { where.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('received_at <= ?'); params.push(untilMs); }
    const sql = `SELECT * FROM span_errors ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY received_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(1, limit | 0), 1000));
    return this.db.prepare(sql).all(...params);
  }

  // Cross-trace logs feed for the Logs & Errors tab. Severity is filtered
  // case-insensitively to absorb the OTel demo's variety
  // (Info/INFO/SeverityNumber-derived). q does a substring match on body.
  listLogs({ severity, q, sinceMs, untilMs, limit = 500 } = {}) {
    const params = [];
    const where = [];
    if (severity) {
      where.push('LOWER(severity) = ?');
      params.push(String(severity).toLowerCase());
    }
    if (q && String(q).trim()) {
      where.push('LOWER(body) LIKE ?');
      params.push(`%${String(q).trim().toLowerCase()}%`);
    }
    if (sinceMs) { where.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('received_at <= ?'); params.push(untilMs); }
    const sql = `SELECT * FROM log_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY received_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(1, limit | 0), 2000));
    return this.db.prepare(sql).all(...params).map(r => ({
      id: r.id,
      traceId: r.trace_id || null,
      spanId: r.span_id || null,
      serviceName: r.service_name,
      severity: r.severity,
      body: r.body,
      attributes: safeJson(r.attributes_json, {}),
      timeUnixNano: r.ts_ns,
      receivedAt: r.received_at,
    }));
  }

  listLogsForTrace(traceId) {
    return this.db.prepare(
      `SELECT * FROM log_records WHERE trace_id = ? ORDER BY ts_ns ASC`
    ).all(traceId).map(r => ({
      id: r.id,
      traceId: r.trace_id,
      spanId: r.span_id || null,
      serviceName: r.service_name,
      severity: r.severity,
      body: r.body,
      attributes: safeJson(r.attributes_json, {}),
      timeUnixNano: r.ts_ns,
      receivedAt: r.received_at,
    }));
  }
}

const safeJson = (raw, fallback) => {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

// Compute p50 and p95 from an unsorted array of numbers in place. Returns
// {p50, p95} or null if the array is empty. Sorts a copy so the caller's data
// is untouched; the histogram callers pass a per-bucket slice so this is fine
// even at TRACE_CAP (500 entries) per request.
const computePercentiles = (arr) => {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const at = (p) => {
    // Nearest-rank: idx = ceil(p*n) - 1, clamped. Matches the
    // listOperations / listOperationLatencies percentile so every rollup agrees.
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[idx];
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
};

// Compact per-operation latency sparkline: split [startMs, endMs] into `buckets`
// equal slices and return the MEAN duration (ms) in each slice — 0 for empty
// slices. Mean (not p95) keeps the line readable when an operation has only a
// handful of traces per slice, where a per-slice p95 would just echo the single
// slowest sample and read as noise. Samples whose timestamp falls outside the
// window are clamped to the nearest edge bucket so a slightly-off received_at
// (clock skew) still contributes rather than vanishing. The Operations tab
// renders this beside the p95 column as a latency trend.
const latencySparkline = (samples, startMs, endMs, buckets) => {
  const n = Math.max(1, buckets | 0);
  const out = new Array(n).fill(0);
  if (!samples || samples.length === 0 || !(endMs > startMs)) return out;
  const size = (endMs - startMs) / n;
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  for (const s of samples) {
    let idx = Math.floor((s.ts - startMs) / size);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    sums[idx] += s.dur || 0;
    counts[idx] += 1;
  }
  for (let i = 0; i < n; i++) out[i] = counts[i] ? sums[i] / counts[i] : 0;
  return out;
};

// Earliest received_at across a table, used to resolve the "All" range (no
// pinned window) to an explicit data-spanning window instead of silently
// defaulting to the last hour. Returns null when the table is empty so the
// caller can fall back to a last-hour default. Cheap — the store is capped and
// received_at is the natural sort column.
OtelStore.prototype.earliestReceivedAt = function (table) {
  const t = table === 'log_records' ? 'log_records' : 'traces';
  const row = this.db.prepare(`SELECT MIN(received_at) AS m FROM ${t}`).get();
  return row && row.m != null ? Number(row.m) : null;
};

// Bin trace rows into a fixed number of equal-width time buckets. Each bucket
// reports total/ok/slow/error counts plus p50/p95 of duration. Used by the
// Traces timeline chart on /otel-data. Service filter matches the trace-list
// behavior (any participant, not just root).
OtelStore.prototype.tracesHistogram = function ({ sinceMs, untilMs, buckets, service, namespace, container, slowThresholdMs }) {
  const now = Date.now();
  const start = sinceMs && Number.isFinite(sinceMs) ? Number(sinceMs) : (this.earliestReceivedAt('traces') ?? now - 60 * 60 * 1000);
  const end = untilMs && Number.isFinite(untilMs) ? Number(untilMs) : now;
  if (end <= start) return { bucketStartMs: start, bucketEndMs: end, bucketSizeMs: 0, buckets: [] };
  const n = Math.min(Math.max(2, buckets | 0 || 60), 240);
  const bucketSize = Math.max(1, Math.floor((end - start) / n));

  const params = [];
  const where = ['t.received_at >= ?', 't.received_at <= ?'];
  params.push(start, end);
  if (service) {
    where.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
    params.push(service);
  }
  if (namespace) {
    where.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
    params.push(namespace);
  }
  if (container) {
    where.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
    params.push(container);
  }
  // Same "any non-internal participant" rule as listTraces — see the comment
  // there for why we don't filter on t.service_name (root) directly.
  where.push(`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.trace_id
                      AND s.service_name NOT IN (${INTERNAL_SERVICES.map(() => '?').join(',')}))`);
  params.push(...INTERNAL_SERVICES);
  const sql = `
    SELECT t.received_at AS ts, t.duration_ms AS dur, t.has_error AS err
    FROM traces t
    WHERE ${where.join(' AND ')}
    ORDER BY t.received_at ASC
  `;
  const rows = this.db.prepare(sql).all(...params);

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      tsMs: start + i * bucketSize,
      total: 0, ok: 0, slow: 0, error: 0,
      p50: null, p95: null, p99: null,
      _durs: [],
    });
  }
  const SLOW_MS = Number.isFinite(slowThresholdMs) && slowThresholdMs > 0 ? slowThresholdMs : 1000;
  for (const r of rows) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((r.ts - start) / bucketSize)));
    const b = out[idx];
    b.total++;
    if (r.err) b.error++;
    else if (r.dur > SLOW_MS) b.slow++;
    else b.ok++;
    b._durs.push(r.dur || 0);
  }
  for (const b of out) {
    const pct = computePercentiles(b._durs);
    if (pct) { b.p50 = pct.p50; b.p95 = pct.p95; b.p99 = pct.p99; }
    delete b._durs;
  }
  return { bucketStartMs: start, bucketEndMs: end, bucketSizeMs: bucketSize, buckets: out };
};

// Bin log records into time buckets, stacked by severity class. Severity is
// normalized into 4 buckets (debug / info / warn / error) to match the
// Logs sub-tab's severity filter.
OtelStore.prototype.logsHistogram = function ({ sinceMs, untilMs, buckets }) {
  const now = Date.now();
  const start = sinceMs && Number.isFinite(sinceMs) ? Number(sinceMs) : (this.earliestReceivedAt('log_records') ?? now - 60 * 60 * 1000);
  const end = untilMs && Number.isFinite(untilMs) ? Number(untilMs) : now;
  if (end <= start) return { bucketStartMs: start, bucketEndMs: end, bucketSizeMs: 0, buckets: [] };
  const n = Math.min(Math.max(2, buckets | 0 || 60), 240);
  const bucketSize = Math.max(1, Math.floor((end - start) / n));

  const rows = this.db.prepare(
    `SELECT received_at AS ts, severity AS sev FROM log_records
     WHERE received_at >= ? AND received_at <= ?
     ORDER BY received_at ASC`
  ).all(start, end);

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ tsMs: start + i * bucketSize, total: 0, debug: 0, info: 0, warn: 0, error: 0 });
  }
  const severityBucket = (sev) => {
    const s = String(sev || '').toLowerCase();
    if (s.startsWith('err') || s.startsWith('fatal') || s.startsWith('crit')) return 'error';
    if (s.startsWith('warn')) return 'warn';
    if (s.startsWith('debug') || s.startsWith('trace')) return 'debug';
    return 'info';
  };
  for (const r of rows) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((r.ts - start) / bucketSize)));
    const b = out[idx];
    b.total++;
    b[severityBucket(r.sev)]++;
  }
  return { bucketStartMs: start, bucketEndMs: end, bucketSizeMs: bucketSize, buckets: out };
};

// Single-round-trip aggregate for the Overview tab. Returns the four headline
// stats (with per-sparkline arrays and delta-vs-previous-window), top services
// and top errors. Window/duration handling matches tracesHistogram so the
// sparklines stay aligned with the bigger timeline chart on Traces.
OtelStore.prototype.overview = function ({ sinceMs, untilMs, service, namespace, container } = {}) {
  const now = Date.now();
  const end = untilMs && Number.isFinite(untilMs) ? Number(untilMs) : now;
  const start = sinceMs && Number.isFinite(sinceMs) ? Number(sinceMs) : (this.earliestReceivedAt('traces') ?? end - 60 * 60 * 1000);
  const span = Math.max(1, end - start);
  // Compare-against window is the same-duration slot immediately prior so
  // the delta indicators ("+12%", "-4%") are stable across page refreshes.
  const prevEnd = start;
  const prevStart = start - span;
  const sparkBuckets = 20;
  const sparkSize = Math.max(1, Math.floor(span / sparkBuckets));

  // Pull trace rows once for both the current and previous windows.
  const params = [prevStart, end];
  // Each filter contributes one participant-subquery AND-clause. Keeping
  // them as separate clauses (rather than combined OR'd in a single
  // subquery) means an unused filter pays no SQL cost.
  const filterClauses = [];
  if (service) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
    params.push(service);
  }
  if (namespace) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
    params.push(namespace);
  }
  if (container) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
    params.push(container);
  }
  const filterClause = filterClauses.length ? 'AND ' + filterClauses.join(' AND ') : '';
  // Same "any non-internal participant" rule as listTraces / tracesHistogram.
  // Without this, topServices reports synthetic verify pings (and other
  // internal pipeline self-telemetry) that the Traces tab then filters out
  // server-side — leading to clickable Top Services rows that land on an
  // empty Traces view.
  const internalClause = `AND EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.trace_id
                                      AND s.service_name NOT IN (${INTERNAL_SERVICES.map(() => '?').join(',')}))`;
  params.push(...INTERNAL_SERVICES);
  const rows = this.db
    .prepare(
      `SELECT t.received_at AS ts, t.duration_ms AS dur, t.has_error AS err, t.service_name AS svc
       FROM traces t
       WHERE t.received_at >= ? AND t.received_at <= ? ${filterClause} ${internalClause}
       ORDER BY t.received_at ASC`,
    )
    .all(...params);

  const curRows = rows.filter(r => r.ts >= start);
  const prevRows = rows.filter(r => r.ts < start);

  const sumStats = (rs) => {
    const total = rs.length;
    const errors = rs.reduce((acc, r) => acc + (r.err ? 1 : 0), 0);
    const durs = rs.map(r => r.dur || 0);
    const p95 = computePercentiles(durs)?.p95 ?? 0;
    const perMin = total / (span / 60000);
    return { total, errors, errorRate: total ? errors / total : 0, p95, perMin };
  };

  // Grafana-style min/max/avg of a sparkline array. Returns null when the
  // array is all zeros — better than rendering "0 / 0 / 0" for an empty window.
  const sparkSummary = (arr) => {
    const positives = arr.filter(v => v > 0);
    if (positives.length === 0) return null;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { min, max, avg };
  };
  const cur = sumStats(curRows);
  const prev = sumStats(prevRows);

  // Sparkline arrays: 20 per-bucket samples for each headline stat.
  const sparkTotals = new Array(sparkBuckets).fill(0);
  const sparkErrors = new Array(sparkBuckets).fill(0);
  const sparkP95Durs = Array.from({ length: sparkBuckets }, () => []);
  for (const r of curRows) {
    const idx = Math.min(sparkBuckets - 1, Math.max(0, Math.floor((r.ts - start) / sparkSize)));
    sparkTotals[idx]++;
    if (r.err) sparkErrors[idx]++;
    sparkP95Durs[idx].push(r.dur || 0);
  }
  const sparkP95 = sparkP95Durs.map(arr => computePercentiles(arr)?.p95 ?? 0);
  const sparkErrorRate = sparkTotals.map((t, i) => (t ? sparkErrors[i] / t : 0));
  const sparkPerMin = sparkTotals.map(t => t / (sparkSize / 60000));

  // Top services by count, with error rate + Apdex.
  // Apdex (New Relic): T = 500ms target latency.
  //   satisfied  = dur <= T && !err
  //   tolerating = T < dur <= 4T && !err
  //   frustrated = dur > 4T || err
  //   apdex = (satisfied + tolerating/2) / total → 0..1
  const APDEX_T_MS = 500;
  const svcMap = new Map();
  for (const r of curRows) {
    const key = r.svc || 'unknown_service';
    const m = svcMap.get(key) || { name: key, count: 0, errorCount: 0, satisfied: 0, tolerating: 0, frustrated: 0 };
    m.count++;
    if (r.err) {
      m.errorCount++;
      m.frustrated++;
    } else {
      const d = r.dur || 0;
      if (d <= APDEX_T_MS) m.satisfied++;
      else if (d <= 4 * APDEX_T_MS) m.tolerating++;
      else m.frustrated++;
    }
    svcMap.set(key, m);
  }
  const topServices = Array.from(svcMap.values())
    .map(m => ({
      name: m.name,
      count: m.count,
      errorCount: m.errorCount,
      errorRate: m.count ? m.errorCount / m.count : 0,
      apdex: m.count ? (m.satisfied + m.tolerating / 2) / m.count : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Top errors by exception_type × service. Same window only; per-bucket
  // sparkline lets the UI show "is this trending up right now?".
  const errParams = [start, end];
  const errRows = this.db
    .prepare(
      `SELECT exception_type, service_name, received_at
       FROM span_errors
       WHERE received_at >= ? AND received_at <= ?`,
    )
    .all(...errParams);
  const errMap = new Map();
  for (const r of errRows) {
    const key = `${r.exception_type || 'exception'}\x1f${r.service_name || ''}`;
    const m = errMap.get(key) || {
      exceptionType: r.exception_type || 'exception',
      serviceName: r.service_name || '',
      count: 0,
      sparkline: new Array(sparkBuckets).fill(0),
    };
    m.count++;
    const idx = Math.min(sparkBuckets - 1, Math.max(0, Math.floor((r.received_at - start) / sparkSize)));
    m.sparkline[idx]++;
    errMap.set(key, m);
  }
  const topErrors = Array.from(errMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const pctDelta = (curV, prevV) => {
    if (!prevV) return curV ? null : 0;
    return (curV - prevV) / prevV;
  };

  return {
    windowMs: { start, end },
    prevWindowMs: { start: prevStart, end: prevEnd },
    sparkBucketSizeMs: sparkSize,
    stats: {
      totalTraces: { value: cur.total, prev: prev.total, delta: pctDelta(cur.total, prev.total), sparkline: sparkTotals, summary: sparkSummary(sparkTotals) },
      p95LatencyMs: { value: cur.p95, prev: prev.p95, delta: pctDelta(cur.p95, prev.p95), sparkline: sparkP95, summary: sparkSummary(sparkP95) },
      errorRate: { value: cur.errorRate, prev: prev.errorRate, delta: pctDelta(cur.errorRate, prev.errorRate), sparkline: sparkErrorRate, summary: sparkSummary(sparkErrorRate) },
      throughputPerMin: { value: cur.perMin, prev: prev.perMin, delta: pctDelta(cur.perMin, prev.perMin), sparkline: sparkPerMin, summary: sparkSummary(sparkPerMin) },
    },
    topServices,
    topErrors,
  };
};

// 2-D heatmap: traces grouped into (time bucket, duration bucket) cells. The
// duration axis is log-scaled so the slow tail is visible without dominating
// the fast bulk — Stackify's perf heatmap does the same trick.
OtelStore.prototype.latencyHeatmap = function ({ sinceMs, untilMs, timeBuckets, durationBuckets, service, namespace, container } = {}) {
  const now = Date.now();
  const end = untilMs && Number.isFinite(untilMs) ? Number(untilMs) : now;
  const start = sinceMs && Number.isFinite(sinceMs) ? Number(sinceMs) : (this.earliestReceivedAt('traces') ?? end - 60 * 60 * 1000);
  if (end <= start) return { timeStart: start, timeEnd: end, timeBuckets: 0, durationBuckets: 0, cells: [], durationEdgesMs: [], maxCount: 0 };
  const nT = Math.min(Math.max(2, timeBuckets | 0 || 60), 240);
  const nD = Math.min(Math.max(3, durationBuckets | 0 || 12), 24);
  const tSize = Math.max(1, Math.floor((end - start) / nT));

  // Pull rows first so the duration axis can auto-range from observed data.
  // Fixed 1ms..10s used to be the only option; that's wrong for either
  // sub-ms RPC services or multi-minute background jobs.
  const params = [start, end];
  const filterClauses = [];
  if (service) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
    params.push(service);
  }
  if (namespace) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
    params.push(namespace);
  }
  if (container) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
    params.push(container);
  }
  const filterClause = filterClauses.length ? 'AND ' + filterClauses.join(' AND ') : '';
  const rows = this.db
    .prepare(
      `SELECT t.received_at AS ts, t.duration_ms AS dur
       FROM traces t
       WHERE t.received_at >= ? AND t.received_at <= ? ${filterClause}`,
    )
    .all(...params);

  // Auto-range the duration axis. Use observed min/max with a small floor +
  // ceiling pad so cells aren't pinned to the very edge. Fall back to a
  // sensible default range when there's no data.
  const observed = rows.map(r => Math.max(0.0001, r.dur || 0));
  let minMs;
  let maxMs;
  if (observed.length === 0) {
    minMs = 1;
    maxMs = 10000;
  } else {
    const obsMin = Math.min(...observed);
    const obsMax = Math.max(...observed);
    // Floor at 0.1ms (sub-ms is rare but possible for trivial RPCs); span
    // at least one order of magnitude so the chart isn't a single hot row.
    minMs = Math.max(0.1, obsMin);
    maxMs = Math.max(minMs * 10, obsMax * 1.1);
  }
  const logMin = Math.log10(minMs);
  const logMax = Math.log10(maxMs);
  const durationEdgesMs = new Array(nD + 1).fill(0).map((_, i) => Math.pow(10, logMin + ((logMax - logMin) * i) / nD));

  // 2-D matrix as flat array, row-major: cells[d * nT + t].
  const cells = new Array(nT * nD).fill(0);
  let maxCount = 0;
  for (const r of rows) {
    const t = Math.min(nT - 1, Math.max(0, Math.floor((r.ts - start) / tSize)));
    let d;
    const dur = Math.max(minMs, r.dur || 0);
    if (dur <= durationEdgesMs[0]) d = 0;
    else if (dur >= durationEdgesMs[nD]) d = nD - 1;
    else d = Math.min(nD - 1, Math.floor(((Math.log10(dur) - logMin) / (logMax - logMin)) * nD));
    const idx = d * nT + t;
    cells[idx]++;
    if (cells[idx] > maxCount) maxCount = cells[idx];
  }

  return {
    timeStart: start,
    timeEnd: end,
    timeBuckets: nT,
    durationBuckets: nD,
    timeBucketSizeMs: tSize,
    durationEdgesMs,
    cells,
    maxCount,
  };
};

// Datadog-style service map. Builds nodes (services that produced traces in
// the window) + edges (inter-service parent→child calls). Layout is computed
// client-side; backend only returns the graph structure plus per-node and
// per-edge stats.
OtelStore.prototype.serviceMap = function ({ sinceMs, untilMs, service, namespace, container } = {}) {
  const now = Date.now();
  const end = untilMs && Number.isFinite(untilMs) ? Number(untilMs) : now;
  const start = sinceMs && Number.isFinite(sinceMs) ? Number(sinceMs) : end - 60 * 60 * 1000;

  const params = [start, end];
  const filterClauses = [];
  if (service) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
    params.push(service);
  }
  if (namespace) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)');
    params.push(namespace);
  }
  if (container) {
    filterClauses.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE container_name = ?)');
    params.push(container);
  }
  const filterClause = filterClauses.length ? 'AND ' + filterClauses.join(' AND ') : '';
  // Hide internal/infra services (gateway, collector, load generator) from the
  // topology too, consistent with the service dropdown and trace/overview totals.
  const internalPh = INTERNAL_SERVICES.map(() => '?').join(',');

  // Per-service rollup over the window. Joining via trace_id keeps the
  // service set consistent with the trace listing UI.
  const nodeRows = this.db.prepare(
    `SELECT
       s.service_name AS name,
       COUNT(DISTINCT s.trace_id) AS trace_count,
       SUM(CASE WHEN s.status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
       AVG(s.duration_ms) AS avg_ms
     FROM spans s
     JOIN traces t ON t.trace_id = s.trace_id
     WHERE t.received_at >= ? AND t.received_at <= ?
       AND s.service_name IS NOT NULL
       ${filterClause}
       AND s.service_name NOT IN (${internalPh})
     GROUP BY s.service_name`,
  ).all(...params, ...INTERNAL_SERVICES);

  // Edges: parent→child span pairs whose service_names differ. Aggregated
  // by (source, target).
  const edgeRows = this.db.prepare(
    `SELECT p.service_name AS source, c.service_name AS target,
            COUNT(*) AS call_count,
            SUM(CASE WHEN c.status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
            AVG(c.duration_ms) AS avg_ms
     FROM spans c
     JOIN spans p ON p.span_id = c.parent_span_id AND p.trace_id = c.trace_id
     JOIN traces t ON t.trace_id = c.trace_id
     WHERE t.received_at >= ? AND t.received_at <= ?
       AND p.service_name IS NOT NULL
       AND c.service_name IS NOT NULL
       AND p.service_name != c.service_name
       ${filterClause}
       AND p.service_name NOT IN (${internalPh})
       AND c.service_name NOT IN (${internalPh})
     GROUP BY p.service_name, c.service_name`,
  ).all(...params, ...INTERNAL_SERVICES, ...INTERNAL_SERVICES);

  const nodes = nodeRows.map(n => ({
    name: n.name,
    traceCount: n.trace_count,
    errorCount: n.error_count || 0,
    errorRate: n.trace_count ? (n.error_count || 0) / n.trace_count : 0,
    avgMs: n.avg_ms || 0,
  })).sort((a, b) => b.traceCount - a.traceCount);

  const edges = edgeRows.map(e => ({
    source: e.source,
    target: e.target,
    callCount: e.call_count,
    errorCount: e.error_count || 0,
    errorRate: e.call_count ? (e.error_count || 0) / e.call_count : 0,
    avgMs: e.avg_ms || 0,
  }));

  return { windowMs: { start, end }, nodes, edges };
};

// Dynatrace "Davis"-style insights: a small rule-based anomaly narrator that
// compares the current overview window to the prior same-duration window and
// emits 0-3 short plain-English findings. Not LLM-driven — these are
// thresholded comparisons that align with the kinds of anomalies a Davis
// would call out, packaged as readable sentences so the surface feels
// AI-flavored without claiming it is.
OtelStore.prototype.insights = function ({ sinceMs, untilMs, service, namespace, container } = {}) {
  const overview = this.overview({ sinceMs, untilMs, service, namespace, container });
  const findings = [];
  const fmtPct = (x) => `${(x * 100).toFixed(0)}%`;
  const fmtMult = (x) => `${x.toFixed(1)}×`;
  const fmtDur = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

  const p95 = overview.stats.p95LatencyMs;
  const err = overview.stats.errorRate;
  const tput = overview.stats.throughputPerMin;

  const hasLatencyJump = p95.value > 100 && p95.prev > 0 && p95.value / p95.prev >= 1.5;
  const hasErrorClimb = err.value >= 0.01 && err.prev >= 0 && err.value - err.prev >= 0.01;
  const hasThroughputDip = tput.prev > 1 && tput.value / Math.max(0.0001, tput.prev) <= 0.5;

  const topService = service || (overview.topServices[0] && overview.topServices[0].name) || null;
  const topErrorService = (overview.topErrors[0] && overview.topErrors[0].serviceName) || topService;

  // Rule: Simultaneity (Combined Anomaly)
  if (hasLatencyJump && hasErrorClimb && hasThroughputDip) {
    findings.push({
      severity: 'danger',
      title: `Possible incident on ${topService || 'primary services'}`,
      body: `Simultaneous p95 latency spike (${fmtMult(p95.value / p95.prev)}), error rate climb (${fmtPct(err.value)}), and throughput dip (${fmtPct(1 - tput.value / tput.prev)}) detected in this window. This suggests a major service disruption or cascading failure.`,
      service: topService,
    });
  } else {
    // Rule 1: p95 latency jump.
    if (hasLatencyJump) {
      findings.push({
        severity: 'warning',
        title: `p95 latency rose ${fmtMult(p95.value / p95.prev)}`,
        body: `Now ${fmtDur(p95.value)}, up from ${fmtDur(p95.prev)} in the prior window. Top contributors: ${overview.topServices.slice(0, 2).map(s => s.name).join(', ') || 'no services in window'}.`,
        service: topService,
      });
    }

    // Rule 2: error-rate climb.
    if (hasErrorClimb) {
      findings.push({
        severity: err.value >= 0.05 ? 'danger' : 'warning',
        title: `Error rate at ${fmtPct(err.value)}`,
        body: `Up from ${fmtPct(err.prev)} in the prior window. ${overview.topErrors[0] ? `Most frequent: ${overview.topErrors[0].exceptionType} on ${overview.topErrors[0].serviceName || 'unknown'} (${overview.topErrors[0].count} occurrences).` : ''}`.trim(),
        service: topErrorService,
      });
    }

    // Rule 3: throughput dip (could indicate upstream issue or downtime).
    if (hasThroughputDip) {
      findings.push({
        severity: 'info',
        title: `Throughput dropped ${fmtPct(1 - tput.value / tput.prev)}`,
        body: `Now ${tput.value.toFixed(1)} traces/min, down from ${tput.prev.toFixed(1)}. Could indicate an upstream pause, a redeploy, or sampling change.`,
        service: topService,
      });
    }
  }

  // Rule 4: a single service dominates errors.
  if (overview.topServices.length > 1) {
    const top = overview.topServices[0];
    if (top.errorRate >= 0.05) {
      findings.push({
        severity: top.errorRate >= 0.2 ? 'danger' : 'warning',
        title: `${top.name} is producing ${fmtPct(top.errorRate)} errors`,
        body: `${top.errorCount} of ${top.count} traces in this window failed. Other top services error rates: ${overview.topServices.slice(1, 4).map(s => `${s.name} ${fmtPct(s.errorRate)}`).join(', ') || 'all healthy'}.`,
        service: top.name,
      });
    }
  }

  return {
    windowMs: overview.windowMs,
    findings: findings.slice(0, 3),
  };
};

module.exports = { OtelStore, extractSpans, extractLogRecords, latencySparkline, TRACE_CAP, TRACE_LIST_MAX, TRACE_RETENTION_MS };
