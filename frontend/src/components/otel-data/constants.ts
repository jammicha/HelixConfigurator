import type { TimeRange } from './types';

export const TIME_RANGES: { value: TimeRange; label: string; ms: number | null }[] = [
  { value: '5m', label: 'Last 5 min', ms: 5 * 60_000 },
  { value: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: 'all', label: 'All', ms: null },
];

export const SLOW_THRESHOLD_MS = 1000;

// Max traces fetched for the list and retained in the live SSE merge. The
// backend keeps a much larger *time-based* window (TRACE_RETENTION_HOURS, 24h by
// default) for the charts and time-range views; the table intentionally shows
// only the most-recent slice — zoom the timeline to reach older traces. The
// /api/traces route clamps anything above TRACE_LIST_MAX (2000).
export const TRACE_LIST_LIMIT = 1000;

// Services emitted by the configurator/sidecar themselves — useful for
// debugging the pipeline, but noise when a user is looking for their app's
// traces. Always hidden now that the "Show internal" toggle was removed.
export const INTERNAL_SERVICES = new Set<string>([
  'helix-gateway',
  'helix-configurator',
  'helix-configurator-verify',
  'otelcol-contrib',
]);

export const MIN_DURATION_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'Any duration' },
  { value: 100, label: '≥ 100ms' },
  { value: 250, label: '≥ 250ms' },
  { value: 500, label: '≥ 500ms' },
  { value: 1000, label: '≥ 1s' },
  { value: 2000, label: '≥ 2s' },
  { value: 5000, label: '≥ 5s' },
];

export const SEVERITY_OPTIONS = ['', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
