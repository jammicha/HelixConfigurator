import React from 'react';
import type { TraceStatus, TraceSummary } from './types';
import { traceStatus } from './utils';
import { useSlowThreshold } from './SlowThresholdContext';

// `status` override lets the service-centric Traces view pass a status derived
// from the selected service's entry span instead of the trace-level verdict.
export const StatusPill: React.FC<{ trace?: TraceSummary; status?: TraceStatus }> = ({ trace, status }) => {
  const slowThresholdMs = useSlowThreshold();
  const resolved = status ?? (trace ? traceStatus(trace, slowThresholdMs) : 'ok');
  if (resolved === 'error') return <span className="adapt-badge-danger">Error</span>;
  if (resolved === 'slow') return <span className="adapt-badge-warning">Slow</span>;
  return <span className="adapt-badge-success">OK</span>;
};
