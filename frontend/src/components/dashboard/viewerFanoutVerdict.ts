// Pure mapping from POST /api/diagnostics/verify-fanout's response to the
// DiagnosticChecksGrid cell state for the "Local Viewer Fan-out" check.
// Extracted rather than left inline in App.tsx's effect, following the same
// pattern as wizard/verifyVerdict.ts: JSX-coupled verdict-mapping logic is
// exactly the kind of thing that kept producing false positives that only
// showed up at runtime there, and this codebase has no DOM testing library —
// pulling the mapping into a pure, dependency-free function is the only way
// it gets unit tested at all. No React, no I/O — all inputs passed in.

export type ViewerFanoutVerdict = 'ok' | 'gateway-unreachable' | 'fanout-failed' | 'error';

// The shape POST /api/diagnostics/verify-fanout always answers with — 200 on
// every verdict, including failure. A failing verdict is a diagnostic
// result, not a request error.
export type VerifyFanoutResponse = {
  verdict: ViewerFanoutVerdict;
  traceId?: string;
  detail?: string;
  remediation?: string;
  elapsedMs?: number;
  // Viewer-exporter-scoped { sent, failed } counters, or null when the
  // gateway's metrics endpoint itself was unreachable. Metrics being
  // unavailable doesn't change the verdict — it's a secondary signal.
  counters: { sent: number; failed: number } | null;
};

// Matches the DiagState shape DiagnosticChecksGrid already expects from the
// other checks (collectorDiag, apiKeyDiag, networkDiag): a status string plus
// an error/remediation pair.
export type ViewerFanoutCellState = {
  // 'PASS'/'CHECKING' match collectorDiag and apiKeyDiag, the closest
  // siblings in DiagnosticChecksGrid. (Those four checks are not internally
  // consistent with each other — networkDiag uses 'Success' — so this aligns
  // with the majority spelling without touching any of their behaviour.)
  status: 'CHECKING' | 'PASS' | 'FAIL';
  error: string;
  remediation: string;
};

// Pass `null` while the canary is in flight (no response yet) — this keeps
// the "checking" state part of the same pure mapping instead of a second,
// untested code path in the effect.
export function computeViewerFanoutCellState(
  response: VerifyFanoutResponse | null,
): ViewerFanoutCellState {
  if (response === null) {
    return { status: 'CHECKING', error: '', remediation: '' };
  }

  if (response.verdict === 'ok') {
    return { status: 'PASS', error: '', remediation: '' };
  }

  // gateway-unreachable, fanout-failed, and error all render as a failed
  // cell — the detail/remediation text, written per-verdict by the backend,
  // is what actually distinguishes them for the user.
  return {
    status: 'FAIL',
    error: response.detail || response.verdict,
    remediation: response.remediation || '',
  };
}
