import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { analyzeCollectorErrorLog, leadingTimestampMs, stripLeadingTimestamp } = require('../exportErrorScan');

const NOW = Date.parse('2026-05-31T16:40:00.000Z');
const stamp = (iso) => `${iso} `;

describe('analyzeCollectorErrorLog', () => {
  it('flags a recent helix export error as ongoing, with a small age', () => {
    const log = [
      `${stamp('2026-05-31T16:39:30.000Z')}info retry_sender.go Exporting failed. Post "http://helix-gateway:4318/v1/metrics": no such host`,
    ].join('\n');
    const r = analyzeCollectorErrorLog(log, NOW);
    expect(r.ongoing).toBe(true);
    expect(r.lastErrorAgeSec).toBe(30);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).not.toMatch(/^2026-05-31T16:39:30/); // leading docker stamp stripped
    expect(r.lines[0]).toContain('helix-gateway');
  });
  it('marks an old (out-of-window) error as NOT ongoing but still returns it', () => {
    const log = `${stamp('2026-05-31T16:35:00.000Z')}info Exporting failed to helix-gateway: no such host`;
    const r = analyzeCollectorErrorLog(log, NOW); // 300s ago, window 90s
    expect(r.ongoing).toBe(false);
    expect(r.lastErrorAgeSec).toBe(300);
  });
  it('treats unparseable-timestamp matches as ongoing (conservative)', () => {
    const r = analyzeCollectorErrorLog('info Exporting failed to helix-gateway: no such host', NOW);
    expect(r.ongoing).toBe(true);
    expect(r.lastErrorAgeSec).toBeNull();
  });
  it('returns null when there are no helix-bound error lines', () => {
    expect(analyzeCollectorErrorLog(`${stamp('2026-05-31T16:39:59.000Z')}info everything is fine`, NOW)).toBeNull();
    // "no such host" without "helix" must NOT match (avoids unrelated false positives)
    expect(analyzeCollectorErrorLog(`${stamp('2026-05-31T16:39:59.000Z')}error kafka: no such host broker`, NOW)).toBeNull();
  });
  it('uses the NEWEST matched error for ongoing/age', () => {
    const log = [
      `${stamp('2026-05-31T16:30:00.000Z')}info Exporting failed helix-gateway no such host`,
      `${stamp('2026-05-31T16:39:50.000Z')}info Exporting failed helix-gateway no such host`,
    ].join('\n');
    const r = analyzeCollectorErrorLog(log, NOW);
    expect(r.lastErrorAgeSec).toBe(10);
    expect(r.ongoing).toBe(true);
  });
});

describe('leadingTimestampMs / stripLeadingTimestamp', () => {
  it('parses and strips a leading RFC3339 stamp', () => {
    const line = '2026-05-31T16:39:30.000Z info hello';
    expect(leadingTimestampMs(line)).toBe(Date.parse('2026-05-31T16:39:30.000Z'));
    expect(stripLeadingTimestamp(line)).toBe('info hello');
  });
  it('leaves a stampless line untouched', () => {
    expect(leadingTimestampMs('info hello')).toBeNull();
    expect(stripLeadingTimestamp('info hello')).toBe('info hello');
  });
});
