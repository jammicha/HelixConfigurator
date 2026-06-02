import { useEffect, useState } from 'react';
import { Waterfall } from './otel-data/trace-detail/Waterfall';
import { parseEmbedParams } from './otel-data/embed/parseEmbedParams';
import type { TraceDetail, LogRecord } from './otel-data/types';

export default function OtelEmbedPage() {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { traceId, spanId } = parseEmbedParams(typeof window !== 'undefined' ? window.location.search : '');

  useEffect(() => {
    if (!traceId) { setError('Missing ?trace= parameter'); setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      fetch(`/api/traces/${traceId}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/logs/${traceId}`).then(r => (r.ok ? r.json() : { logs: [] })),
    ]).then(([d, l]) => {
      if (cancelled) return;
      if (!d) { setError('Trace not found'); setLoading(false); return; }
      setDetail(d as TraceDetail);
      setLogs(((l && l.logs) || []) as LogRecord[]);
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError('Failed to load trace'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [traceId]);

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading trace…</div>;
  if (error || !detail) return <div className="p-4 text-sm text-red-400">{error || 'No trace'}</div>;

  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100">
      <Waterfall detail={detail} logs={logs} focusSpanId={spanId} />
    </div>
  );
}
