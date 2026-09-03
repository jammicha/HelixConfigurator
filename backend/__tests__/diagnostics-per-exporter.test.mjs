import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sumPromCounter, perExporterCounters, exporterVerdict } = require('../routes/diagnostics.js');

const METRICS = `
otelcol_exporter_sent_spans_total{exporter="otlphttp/bmchelix_default"} 500
otelcol_exporter_send_failed_spans_total{exporter="otlphttp/bmchelix_default"} 0
otelcol_exporter_sent_spans_total{exporter="otlphttp/bmchelix_beta"} 0
otelcol_exporter_send_failed_spans_total{exporter="otlphttp/bmchelix_beta"} 300
otelcol_exporter_sent_spans_total{exporter="otlphttp/helix_local_viewer"} 999
`;

// A legacy (upgraded, un-migrated-YAML) single-tenant install still runs the
// bare `otlphttp/bmchelix` exporter (no trailing underscore suffix). It must
// be recognized as managed too, not just the prefixed per-connection names.
const LEGACY_METRICS = `
otelcol_exporter_sent_spans_total{exporter="otlphttp/bmchelix"} 777
otelcol_exporter_send_failed_spans_total{exporter="otlphttp/bmchelix"} 0
otelcol_exporter_sent_spans_total{exporter="otlphttp/helix_local_viewer"} 999
`;

describe('sumPromCounter with exporterMatch', () => {
  it('sums across all managed exporters', () => {
    const total = sumPromCounter(METRICS, 'otelcol_exporter_sent_spans', { exporterMatch: (n) => n.startsWith('otlphttp/bmchelix_') });
    expect(total).toBe(500);
  });

  it('sums the bare legacy exporter name too', () => {
    const isManagedExporterName = (n) => n === 'otlphttp/bmchelix' || n.startsWith('otlphttp/bmchelix_');
    const total = sumPromCounter(LEGACY_METRICS, 'otelcol_exporter_sent_spans', { exporterMatch: isManagedExporterName });
    expect(total).toBe(777);
  });
});

describe('perExporterCounters', () => {
  it('breaks sent/failed out per managed exporter', () => {
    const byExp = perExporterCounters(METRICS);
    expect(byExp['otlphttp/bmchelix_default']).toEqual({ sent: 500, failed: 0 });
    expect(byExp['otlphttp/bmchelix_beta']).toEqual({ sent: 0, failed: 300 });
    expect(byExp['otlphttp/helix_local_viewer']).toBeUndefined();
  });

  it('includes the bare legacy exporter under its real name', () => {
    const byExp = perExporterCounters(LEGACY_METRICS);
    expect(byExp['otlphttp/bmchelix']).toEqual({ sent: 777, failed: 0 });
    expect(byExp['otlphttp/helix_local_viewer']).toBeUndefined();
  });
});

describe('exporterVerdict', () => {
  it('flags a dead tenant even when another is healthy', () => {
    const byExp = perExporterCounters(METRICS);
    expect(exporterVerdict(byExp['otlphttp/bmchelix_default'])).toBe('healthy');
    expect(exporterVerdict(byExp['otlphttp/bmchelix_beta'])).toBe('failing');
    expect(exporterVerdict({ sent: 0, failed: 0 })).toBe('idle');
  });
});
