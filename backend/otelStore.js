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

const TRACE_CAP = 500;

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
  constructor({ dbPath }) {
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._initSchema();
    this._prepStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        service_name TEXT,
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
    `);
  }

  _prepStatements() {
    this.upsertSpan = this.db.prepare(`
      INSERT INTO spans (span_id, trace_id, parent_span_id, service_name, name, kind,
                          start_time_ns, end_time_ns, duration_ms, status_code, status_message,
                          attributes_json, events_json)
      VALUES (@spanId, @traceId, @parentSpanId, @serviceName, @name, @kind,
              @startTimeNs, @endTimeNs, @durationMs, @statusCode, @statusMessage,
              @attributesJson, @eventsJson)
      ON CONFLICT(span_id, trace_id) DO UPDATE SET
        parent_span_id = excluded.parent_span_id,
        service_name = excluded.service_name,
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
      INSERT INTO traces (trace_id, service_name, root_operation, start_time_ns, end_time_ns,
                          duration_ms, span_count, has_error, received_at)
      SELECT
        @traceId,
        COALESCE((SELECT service_name FROM spans WHERE trace_id = @traceId
                   AND (parent_span_id IS NULL OR parent_span_id = '') LIMIT 1),
                 (SELECT service_name FROM spans WHERE trace_id = @traceId LIMIT 1)),
        COALESCE((SELECT name FROM spans WHERE trace_id = @traceId
                   AND (parent_span_id IS NULL OR parent_span_id = '') LIMIT 1),
                 (SELECT name FROM spans WHERE trace_id = @traceId
                   ORDER BY start_time_ns ASC LIMIT 1)),
        (SELECT MIN(start_time_ns) FROM spans WHERE trace_id = @traceId),
        (SELECT MAX(end_time_ns) FROM spans WHERE trace_id = @traceId),
        (SELECT (MAX(end_time_ns) - MIN(start_time_ns)) / 1e6 FROM spans WHERE trace_id = @traceId),
        (SELECT COUNT(*) FROM spans WHERE trace_id = @traceId),
        (SELECT CASE WHEN MAX(status_code) >= 2 THEN 1
                     WHEN EXISTS (SELECT 1 FROM span_errors WHERE trace_id = @traceId) THEN 1
                     ELSE 0 END FROM spans WHERE trace_id = @traceId),
        @receivedAt
      ON CONFLICT(trace_id) DO UPDATE SET
        service_name = excluded.service_name,
        root_operation = excluded.root_operation,
        start_time_ns = excluded.start_time_ns,
        end_time_ns = excluded.end_time_ns,
        duration_ms = excluded.duration_ms,
        span_count = excluded.span_count,
        has_error = excluded.has_error,
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
    });
    tx();

    for (const summary of summaries) {
      if (summary) this.events.emit('trace', summary);
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
  listOperations({ sinceMs, untilMs } = {}) {
    const params = [];
    const where = [];
    if (sinceMs) { where.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('received_at <= ?'); params.push(untilMs); }
    const sql = `SELECT service_name, root_operation, duration_ms, has_error
                 FROM traces ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const rows = this.db.prepare(sql).all(...params);
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.service_name || ''}|${r.root_operation || ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          service_name: r.service_name || '',
          root_operation: r.root_operation || '',
          durations: [],
          error_count: 0,
          slow_count: 0,
        };
        groups.set(key, g);
      }
      g.durations.push(r.duration_ms);
      if (r.has_error) g.error_count += 1;
      if (r.duration_ms > 1000) g.slow_count += 1;
    }
    const percentile = (sorted, p) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
      return sorted[idx];
    };
    return Array.from(groups.values()).map(g => {
      const sorted = g.durations.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
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
      };
    }).sort((a, b) => b.trace_count - a.trace_count);
  }

  _evictIfNeeded() {
    const { n } = this.countTraces.get();
    if (n <= TRACE_CAP) return;
    const overflow = n - TRACE_CAP;
    const victims = this.oldestTraceIds.all(overflow).map(r => r.trace_id);
    for (const traceId of victims) {
      this.deleteSpansForTrace.run(traceId);
      this.deleteErrorsForTrace.run(traceId);
      this.deleteLogsForTrace.run(traceId);
      this.deleteTrace.run(traceId);
    }
  }

  listTraces({ service, sinceMs, untilMs, limit = 200 }) {
    const params = [];
    const where = [];
    // Filter by participant, not just by root service. Otherwise services
    // that only appear as downstream callees (checkout/payment/email/etc in
    // the OTel demo, where load-generator starts every trace) are invisible.
    if (service) {
      where.push('t.trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_name = ?)');
      params.push(service);
    }
    if (sinceMs) { where.push('t.received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('t.received_at <= ?'); params.push(untilMs); }
    // Subquery rollups: log_count and error_count are cheap (indexed on
    // trace_id). db_call_count uses json_extract on the spans attributes
    // blob — fine for the 200-row cap, but watch this if the cap grows.
    const sql = `
      SELECT
        t.*,
        (SELECT COUNT(*) FROM log_records WHERE trace_id = t.trace_id) AS log_count,
        (SELECT COUNT(*) FROM span_errors WHERE trace_id = t.trace_id) AS error_count,
        (SELECT COUNT(*) FROM spans
           WHERE trace_id = t.trace_id
             AND (json_extract(attributes_json, '$."db.system"') IS NOT NULL
               OR json_extract(attributes_json, '$."db.system.name"') IS NOT NULL)
        ) AS db_call_count
      FROM traces t
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.received_at DESC LIMIT ?
    `;
    params.push(Math.min(Math.max(1, limit | 0), TRACE_CAP));
    return this.db.prepare(sql).all(...params);
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

  listServices() {
    // Count each service by how many traces it participates in (any span),
    // not by how many traces it roots. Mirrors what the user expects from
    // Jaeger/Tempo: every service that touches a trace is a valid filter.
    return this.db.prepare(
      `SELECT service_name AS name, COUNT(DISTINCT trace_id) AS traceCount FROM spans
       WHERE service_name IS NOT NULL GROUP BY service_name ORDER BY service_name ASC`
    ).all();
  }

  listErrors({ limit = 200 } = {}) {
    return this.db.prepare(
      `SELECT * FROM span_errors ORDER BY received_at DESC LIMIT ?`
    ).all(Math.min(Math.max(1, limit | 0), 1000));
  }

  // Cross-trace logs feed for the Logs & Errors tab. Severity is filtered
  // case-insensitively to absorb the OTel demo's variety
  // (Info/INFO/SeverityNumber-derived). q does a substring match on body.
  listLogs({ severity, q, sinceMs, limit = 500 } = {}) {
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

module.exports = { OtelStore, extractSpans, extractLogRecords };
