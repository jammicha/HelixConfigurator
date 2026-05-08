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
  const records = [];
  // OTel error status (status.code === 2 → ERROR)
  if (span.statusCode === 2) {
    records.push({
      traceId: span.traceId,
      spanId: span.spanId,
      serviceName: span.serviceName,
      exceptionType: 'span.error',
      message: span.statusMessage || span.name || 'Span reported error status',
      stack: '',
      tsNs: span.endTimeNs,
    });
  }
  // OTel exception events (semantic convention)
  for (const ev of span.events || []) {
    if (ev.name !== 'exception') continue;
    records.push({
      traceId: span.traceId,
      spanId: span.spanId,
      serviceName: span.serviceName,
      exceptionType: ev.attributes['exception.type'] || 'exception',
      message: ev.attributes['exception.message'] || '',
      stack: ev.attributes['exception.stacktrace'] || '',
      tsNs: ev.timeUnixNano || span.endTimeNs,
    });
  }
  return records;
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
    return summaries;
  }

  ingestLogs(rawLogs) {
    if (!rawLogs || !rawLogs.length) return 0;
    const now = Date.now();
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
      }
    });
    tx();
    for (const log of rawLogs) {
      this.events.emit('log', { ...log, receivedAt: now });
    }
    return rawLogs.length;
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
    if (service) { where.push('service_name = ?'); params.push(service); }
    if (sinceMs) { where.push('received_at >= ?'); params.push(sinceMs); }
    if (untilMs) { where.push('received_at <= ?'); params.push(untilMs); }
    const sql = `SELECT * FROM traces ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY received_at DESC LIMIT ?`;
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
    return this.db.prepare(
      `SELECT service_name AS name, COUNT(*) AS traceCount FROM traces
       WHERE service_name IS NOT NULL GROUP BY service_name ORDER BY service_name ASC`
    ).all();
  }

  listErrors({ limit = 200 } = {}) {
    return this.db.prepare(
      `SELECT * FROM span_errors ORDER BY received_at DESC LIMIT ?`
    ).all(Math.min(Math.max(1, limit | 0), 1000));
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
