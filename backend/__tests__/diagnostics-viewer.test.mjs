import { describe, it, expect } from 'vitest';
import { fetchViewerCounters } from '../routes/diagnostics.js';

// Metric names carry the Prometheus/OpenMetrics `_total` counter suffix,
// matching what the OTel Collector's Prometheus exporter actually emits and
// what sumPromCounter's `baseName + '_total'` match requires (diagnostics.js
// ~line 48).
const METRICS = `
# HELP otelcol_exporter_sent_spans
otelcol_exporter_sent_spans_total{exporter="otlphttp/bmchelix"} 894
otelcol_exporter_sent_spans_total{exporter="otlphttp/helix_local_viewer"} 0
otelcol_exporter_send_failed_spans_total{exporter="otlphttp/bmchelix"} 0
otelcol_exporter_send_failed_spans_total{exporter="otlphttp/helix_local_viewer"} 131
otelcol_exporter_send_failed_log_records_total{exporter="otlphttp/helix_local_viewer"} 12
`;

describe('fetchViewerCounters', () => {
  it('reads counters scoped to the viewer exporter, not the helix exporter', () => {
    expect(fetchViewerCounters(METRICS)).toEqual({ sent: 0, failed: 143 });
  });

  it('returns zeroes when the viewer exporter is absent from the metrics', () => {
    expect(fetchViewerCounters('otelcol_exporter_sent_spans_total{exporter="otlphttp/bmchelix"} 5'))
      .toEqual({ sent: 0, failed: 0 });
  });
});
