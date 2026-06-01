// Substrings that mark a collector log line as relevant to the Helix export
// path (auth, the otlphttp/bmchelix exporter, queueing, retryable vs
// permanent errors). The "helix" log filter keeps only lines matching one of
// these so the diagnostic pane isn't drowned by unrelated app chatter.
export const HELIX_LOG_KEYWORDS = [
  'bmchelix', 'otlphttp', 'exporter', 'sending queue',
  'unauthenticated', 'unauthorized', 'forbidden',
  'connection refused', 'deadline exceeded', 'exporting failed',
  'critical otel drop', 'permanent error', 'not retryable',
  'x-api-key', 'x-source', 'helix-gateway',
];

export const isHelixRelevant = (line: string): boolean => {
  const lower = line.toLowerCase();
  return HELIX_LOG_KEYWORDS.some(kw => lower.includes(kw));
};
