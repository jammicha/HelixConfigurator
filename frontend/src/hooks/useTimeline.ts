import { useState } from 'react';

export type TimelineKind = 'config-saved' | 'restart' | 'attach' | 'error-spike' | 'verify';
export type TimelineEvent = { ts: number; kind: TimelineKind; message: string };

const TIMELINE_MAX = 30;

// Lightweight in-memory event timeline shown above the diagnostic log pane —
// helps answer "what changed?" without scraping logs. Append-only with a cap;
// oldest entries evict from the front on overflow.
export const useTimeline = () => {
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

  const pushTimelineEvent = (kind: TimelineKind, message: string) => {
    setTimeline(prev => {
      const next = [...prev, { ts: Date.now(), kind, message }];
      return next.length > TIMELINE_MAX ? next.slice(-TIMELINE_MAX) : next;
    });
  };

  const clearTimeline = () => setTimeline([]);

  return { timeline, pushTimelineEvent, clearTimeline };
};
