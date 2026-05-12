import React from 'react';
import type { TraceSummary } from './types';
import { traceStatus } from './utils';
import { useSlowThreshold } from './SlowThresholdContext';

export const StatusPill: React.FC<{ trace: TraceSummary }> = ({ trace }) => {
  const slowThresholdMs = useSlowThreshold();
  const status = traceStatus(trace, slowThresholdMs);
  if (status === 'error') return <span className="adapt-badge-danger">Error</span>;
  if (status === 'slow') return <span className="adapt-badge-warning">Slow</span>;
  return <span className="adapt-badge-success">OK</span>;
};
