import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, X } from 'lucide-react';
import type { HelixEnv, LogRecord, TraceDetail } from '../types';
import { buildHelixTraceUrl, formatRelative, hasRealHelixEndpoint } from '../utils';
import { BmcChevron } from '../BmcChevron';
import { CopyButton } from '../CopyButton';
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

  // Per-trace attempt history (all sends, successful or failed). Kept
  // separately from priorSend so a failed attempt is still inspectable after
  // a page reload, and so multiple retries show up as a small disclosure
  // panel in the drawer instead of overwriting each other.
  const ATTEMPT_LOG_KEY = 'helix-otel.sendAttempts';
  type AttemptRecord = { at: number; ok: boolean; severity?: string; error?: string };
  const readAttemptsMap = (): Record<string, AttemptRecord[]> => {
    try { return JSON.parse(localStorage.getItem(ATTEMPT_LOG_KEY) || '{}') || {}; }
    catch { return {}; }
  };
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);

  useEffect(() => {
    setSendState('idle');
    setSendMsg('');
    setPriorSend(readSentMap()[traceId] || null);
    setAttempts(readAttemptsMap()[traceId] || []);
  }, [traceId]);

  const p95Ms = detail
    ? operationP95.get(`${detail.summary.service_name}|${detail.summary.root_operation}`) || 0
    : 0;
  const isOutlier = !!detail && p95Ms > 0 && detail.summary.duration_ms > p95Ms * 2;
  const hasError = !!detail && !!detail.summary.has_error;
  const isAnomalous = hasError || isOutlier;
  const alreadySent = !!priorSend && sendState !== 'sent' && sendState !== 'sending';

  // Generic AIOps console URL. We don't (yet) have a validated portal URL
  // pattern for an individual Event by id, so the post-send "Open AIOps"
  // link lands on the console root and the user navigates to Situations
  // from there. TODO #13 will validate the precise event-detail path and
  // this can be refined to deep-link directly. Hidden when no real endpoint
  // is configured (install-bundle placeholder).
  const aiopsConsoleUrl = hasRealHelixEndpoint(helixEnv)
    ? `${helixEnv!.endpoint.replace(/\/+$/, '')}/aiops/`
    : null;

  const recordAttempt = (record: AttemptRecord) => {
    // Cap at 10 attempts per trace so a runaway retry loop can't bloat
    // localStorage. Newest first; matches the disclosure-panel render order.
    try {
      const map = readAttemptsMap();
      const list = [record, ...(map[traceId] || [])].slice(0, 10);
      map[traceId] = list;
      localStorage.setItem(ATTEMPT_LOG_KEY, JSON.stringify(map));
      setAttempts(list);
    } catch { /* localStorage may be unavailable — silent */ }
  };

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
        const severity = data.severity || 'EVENT';
        setSendState('sent');
        setSendMsg(`Sent as ${severity}.`);
        try {
          const map = readSentMap();
          map[traceId] = { sentAt: Date.now(), severity };
          localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(map));
          setPriorSend(map[traceId]);
        } catch { /* localStorage may be unavailable — silent */ }
        recordAttempt({ at: Date.now(), ok: true, severity });
      } else {
        const error = data.error || `Request failed (${res.status})`;
        setSendState('error');
        setSendMsg(error);
        recordAttempt({ at: Date.now(), ok: false, error });
      }
    } catch (e: any) {
      const error = e.message || 'Network error';
      setSendState('error');
      setSendMsg(error);
      recordAttempt({ at: Date.now(), ok: false, error });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-[80rem] h-full bg-gray-1000 border-l border-gray-800 flex flex-col shadow-4">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
          <div>
            <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Trace</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-mono text-sm text-gray-200 select-all">{traceId}</span>
              <CopyButton value={traceId} title="Copy trace ID" stopPropagation={false} />
            </div>
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
                      ? 'This trace is flagged as anomalous. Sending it as an AIOps event will surface it for correlation.'
                      : 'Send this trace as an event to AIOps. Correlation policies on your tenant decide how it groups into a Situation.'}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-tiny font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    alreadySent
                      ? 'border border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                      : isAnomalous
                        ? hasError
                          ? 'border border-danger/60 bg-danger/10 text-danger-text hover:bg-danger/20'
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
                    : sendState === 'error' ? 'Send failed (retry)'
                    : alreadySent ? 'Sent. Send again?'
                    : isAnomalous ? 'Send anomaly to AIOps' : 'Send to AIOps as event'}
                </button>
                {(sendMsg || alreadySent || attempts.length > 0) && (
                  <div className="absolute top-full right-0 mt-1 max-w-xs text-right z-30">
                    <div className={`text-tiny ${sendState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>
                      {sendMsg || (alreadySent
                        ? `Already sent ${formatRelative(priorSend!.sentAt)} as ${priorSend!.severity}.`
                        : '')}
                      {sendState === 'sent' && aiopsConsoleUrl && (
                        <>
                          {' '}
                          <a
                            href={aiopsConsoleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-link hover:text-white"
                            title="Open the AIOps console. Find your event in the Situations list (precise event-detail URL refines once validated)."
                          >
                            Open AIOps <ExternalLink className="w-3 h-3" />
                          </a>
                        </>
                      )}
                    </div>
                    {attempts.length > 0 && (
                      <details className="mt-1 bg-gray-900 border border-gray-800 rounded text-tiny text-left">
                        <summary className="cursor-pointer px-2 py-1 text-gray-500 hover:text-gray-300 select-none">
                          Send history ({attempts.length})
                        </summary>
                        <ul className="px-2 pb-2 space-y-0.5 max-h-48 overflow-auto">
                          {attempts.map((a, i) => (
                            <li key={i} className={a.ok ? 'text-gray-400' : 'text-danger-text'}>
                              <span className="text-gray-500">{formatRelative(a.at)}</span>
                              {' · '}
                              {a.ok ? `sent as ${a.severity || 'EVENT'}` : (a.error || 'failed')}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
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
                    namespace: detail.summary.service_namespace,
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
