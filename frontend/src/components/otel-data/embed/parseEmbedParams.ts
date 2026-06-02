export type EmbedParams = { traceId: string | null; spanId: string | null };

export function parseEmbedParams(search: string): EmbedParams {
  const p = new URLSearchParams(search || '');
  const traceId = (p.get('trace') || '').trim() || null;
  const spanId = (p.get('span') || '').trim() || null;
  return { traceId, spanId };
}
