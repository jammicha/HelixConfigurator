import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, X } from 'lucide-react';
import type { HelixEnv, LogRecord, TraceDetail } from '../types';
import { buildHelixTraceUrl, formatRelative } from '../utils';
import { BmcChevron } from '../BmcChevron';
import { Waterfall } from './Waterfall';

export const TraceDetailDrawer: React.FC<{
  traceId: string;
  detail: TraceDetail | null;
  logs: LogRecord[];
  loading: boolean;
  helixEnv: HelixEnv | null;
  operationP95: Map<string, number>;
  onClose: () => void;
}> = ({ traceId, detail, logs, loading, helixEnv, operationP95, onClose }) => {
  // Press ESC to close — matches the existing modals in App.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Send-to-AIOps state. Inline (vs global toast) keeps feedback adjacent to
  // the button you clicked. Resets to idle when the drawer opens a new trace.
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendMsg, setSendMsg] = useState<string>('');
  // localStorage-backed "already sent" tracking. BMC's auto-dedup only fires
  // when the event class has source_identifier as a dedup slot — base EVENT
  // typically doesn't, so without this guard a re-click creates a duplicate
  // event in AIOps. Survives drawer close/reopen and page reload.
  const SENT_STORAGE_KEY = 'helix-otel.sentEvents';
  type SentRecord = { sentAt: number; severity: string };
  const readSentMap = (): Record<string, SentRecord> => {
    try { return JSON.parse(localStorage.getItem(SENT_STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  };
  const [priorSend, setPriorSend] = useState<SentRecord | null>(null);
  useEffect(() => {
    setSendState('idle');
    setSendMsg('');
    setPriorSend(readSentMap()[traceId] || null);
  }, [traceId]);

  const p95Ms = detail
    ? operationP95.get(`${detail.summary.service_name}|${detail.summary.root_operation}`) || 0
    : 0;
  const isOutlier = !!detail && p95Ms > 0 && detail.summary.duration_ms > p95Ms * 2;
  const hasError = !!detail && !!detail.summary.has_error;
  const isAnomalous = hasError || isOutlier;
  const alreadySent = !!priorSend && sendState !== 'sent' && sendState !== 'sending';

  const sendToAiops = async () => {
    if (!detail) return;
    setSendState('sending');
    setSendMsg('');
    try {
      const res = await fetch('/api/situations/convert-trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceId, p95Ms: p95Ms || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSendState('sent');
        setSendMsg(`Sent as ${data.severity || 'EVENT'} — watch your AIOps Situations console.`);
        try {
          const map = readSentMap();
          map[traceId] = { sentAt: Date.now(), severity: data.severity || 'EVENT' };
          localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(map));
          setPriorSend(map[traceId]);
        } catch { /* localStorage may be unavailable — silent */ }
      } else {
        setSendState('error');
        setSendMsg(data.error || `Request failed (${res.status})`);
      }
    } catch (e: any) {
      setSendState('error');
      setSendMsg(e.message || 'Network error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-[80rem] h-full bg-gray-1000 border-l border-gray-800 flex flex-col shadow-4">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
          <div>
            <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Trace</div>
            <div className="font-mono text-sm text-gray-200 mt-0.5 select-all">{traceId}</div>
          </div>
          <div className="flex items-center gap-2">
            {detail && (
              <div className="relative flex flex-col items-end">
                <button
                  onClick={sendToAiops}
                  disabled={sendState === 'sending'}
                  title={alreadySent
                    ? `Already sent at ${new Date(priorSend!.sentAt).toLocaleTimeString()} as ${priorSend!.severity}.`
                    : isAnomalous
                      ? 'This trace is flagged as anomalous — sending it as an AIOps event will surface it for correlation.'
                      : 'Send this trace as an event to AIOps. Correlation policies on your tenant decide how it groups into a Situation.'}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-tiny font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    alreadySent
                      ? 'border border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                      : isAnomalous
                        ? hasError
                          ? 'border border-danger/60 bg-danger/10 text-danger hover:bg-danger/20'
                          : 'border border-warning/60 bg-warning/10 text-warning hover:bg-warning/20'
                        : 'border border-gray-800 text-gray-300 hover:border-active hover:text-white'
                  }`}
                >
                  {sendState === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" />
                    : sendState === 'sent' ? <Check className="w-4 h-4" />
                    : sendState === 'error' ? <AlertTriangle className="w-4 h-4" />
                    : alreadySent ? <Check className="w-4 h-4" />
                    : <BmcChevron className="h-4 w-auto" />}
                  {sendState === 'sending' ? 'Sending…'
                    : sendState === 'sent' ? 'Sent to AIOps'
                    : sendState === 'error' ? 'Send failed — retry'
                    : alreadySent ? 'Sent — send again?'
                    : isAnomalous ? 'Send anomaly to AIOps' : 'Send to AIOps as event'}
                </button>
                {(sendMsg || alreadySent) && (
                  <div className={`absolute top-full right-0 mt-1 text-tiny max-w-xs text-right whitespace-nowrap ${sendState === 'error' ? 'text-danger' : 'text-gray-400'}`}>
                    {sendMsg || (alreadySent
                      ? `Already sent ${formatRelative(priorSend!.sentAt)} as ${priorSend!.severity}`
                      : '')}
                  </div>
                )}
              </div>
            )}
            {(() => {
              const url = detail
                ? buildHelixTraceUrl(helixEnv, {
                    traceId,
                    serviceName: detail.summary.service_name,
                    timeNs: detail.summary.start_time_ns,
                  })
                : null;
              if (!url) return null;
              return (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-gray-800 hover:border-active text-tiny font-semibold text-gray-300 hover:text-white transition-colors"
                >
                  <BmcChevron className="h-4 w-auto" />
                  View in Helix
                  <ExternalLink className="w-4 h-4 opacity-70" />
                </a>
              );
            })()}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800">
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading trace…
            </div>
          ) : !detail ? (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">Trace not found.</div>
          ) : (
            <Waterfall detail={detail} logs={logs} />
          )}
        </div>
      </aside>
    </div>
  );
};
