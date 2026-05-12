import React from 'react';
import type { LogRecord } from '../types';
import { formatTime } from '../utils';

export const LogLine: React.FC<{ log: LogRecord }> = ({ log }) => {
  const sevTone = /error|fatal|critical/i.test(log.severity)
    ? 'text-[#ff8a8a]'
    : /warn/i.test(log.severity)
      ? 'text-warning'
      : 'text-gray-300';
  return (
    <div className="text-tiny font-mono flex gap-2" style={{ fontFamily: "'Source Code Pro', monospace" }}>
      <span className="text-gray-500 flex-shrink-0">{formatTime(log.receivedAt)}</span>
      {log.severity && <span className={`${sevTone} flex-shrink-0`}>{log.severity.toUpperCase()}</span>}
      <span className="text-gray-200 break-all">{log.body}</span>
    </div>
  );
};
