// The diagnostic log pane keeps only the most recent LOG_CAP lines, matching
// the last-N slice the live SSE stream applies as each line arrives.
export const LOG_CAP = 100;

// When the stream is paused, incoming lines are held in a side buffer instead
// of the visible log so the pane stays frozen for reading. On resume we merge
// that buffer back in, preserving order and re-applying the same last-N cap.
export const mergePausedLogs = (
  logs: string[],
  buffered: string[],
  cap: number = LOG_CAP,
): string[] => [...logs, ...buffered].slice(-cap);
