import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import otelStoreModule from './otelStore.js';

const { OtelStore } = otelStoreModule;

// Regression coverage for the corrupt-store self-heal (otelStore._openVerified).
// A corrupt page in the spans B-tree used to make every Traces-tab query throw
// "database disk image is malformed" forever, while Logs/Errors (which never
// read spans) kept working — so the fault hid as a silently-empty Traces tab.
// The store now quick_checks at startup and quarantines + rebuilds a bad file.
describe('OtelStore corrupt-store self-heal', () => {
  let tmpDir = null;
  let store = null;

  const freshTmp = () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otelstore-'));
    return path.join(tmpDir, 'otel-store.db');
  };
  const quarantineFiles = () =>
    fs.readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'));

  afterEach(() => {
    if (store) {
      try { store.stopMaintenance(); } catch { /* noop */ }
      try { store.db.close(); } catch { /* noop */ }
      store = null;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('quarantines a non-database file and starts a fresh, queryable store', () => {
    const dbPath = freshTmp();
    // Not a SQLite database at all — quick_check (or the open) throws.
    fs.writeFileSync(dbPath, Buffer.from('definitely not a sqlite database '.repeat(64)));

    store = new OtelStore({ dbPath });

    // The replacement store answers queries instead of throwing.
    expect(store.listTraces({})).toEqual([]);
    expect(store.listLogs({})).toEqual([]);
    // The bad file was moved aside (kept for forensics), not silently dropped.
    expect(quarantineFiles().length).toBeGreaterThan(0);
  });

  it('quarantines a database with corrupt pages (valid header, bad B-tree)', () => {
    const dbPath = freshTmp();
    // Build a real, multi-page database, then scribble garbage across interior
    // pages — the closest reproduction of the production failure, where the
    // header is intact but quick_check returns a non-"ok" verdict.
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, blob TEXT)');
    const insert = seed.prepare('INSERT INTO t(blob) VALUES (?)');
    seed.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run('x'.repeat(210));
    })();
    seed.close();

    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(40960, 0xff), 0, 40960, 4096 * 4); // pages ~5-14
    fs.closeSync(fd);

    // Precondition: the corruption is genuinely detectable (tolerate either a
    // non-"ok" verdict or a thrown check — both are "not healthy").
    const probe = new Database(dbPath);
    let verdict;
    try { verdict = probe.pragma('quick_check', { simple: true }); }
    catch (e) { verdict = `threw: ${e.message}`; }
    probe.close();
    expect(verdict).not.toBe('ok');

    store = new OtelStore({ dbPath });

    expect(store.listTraces({})).toEqual([]);
    expect(quarantineFiles().length).toBeGreaterThan(0);
  });

  it('leaves a healthy store untouched and preserves its data on reopen', () => {
    const dbPath = freshTmp();
    const first = new OtelStore({ dbPath });
    first.ingestSpans([{
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: '',
      serviceName: 'cart-api', serviceNamespace: 'shop', containerName: 'cart',
      name: 'GET /cart', kind: 2, startTimeNs: 1_000, endTimeNs: 6_000,
      durationMs: 5, statusCode: 1, statusMessage: '', attributes: {}, events: [],
    }]);
    first.db.pragma('wal_checkpoint(TRUNCATE)');
    first.stopMaintenance();
    first.db.close();

    // Reopen the same path — a healthy store must NOT be quarantined.
    store = new OtelStore({ dbPath });

    expect(store.listTraces({}).length).toBe(1);
    expect(quarantineFiles().length).toBe(0);
  });
});
