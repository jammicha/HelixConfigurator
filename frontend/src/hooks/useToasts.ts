import { useEffect, useRef, useState } from 'react';
import type { Toast } from '../components/ToastStack';

const TOAST_MAX = 3;       // Stack depth; a burst beyond this evicts the oldest.
const TOAST_TTL_MS = 3000; // Auto-dismiss delay per toast.

export type ShowToast = (message: string, type?: 'success' | 'error') => void;

// Toast stack with FIFO eviction and per-toast auto-dismiss timers. Timers are
// tracked in a ref so an evicted toast's pending dismiss can be cancelled and
// so every timer can be cleared on unmount. Older toasts evict on overflow so
// a burst of errors doesn't clobber earlier context.
export const useToasts = (): { toasts: Toast[]; showToast: ShowToast } => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const showToast: ShowToast = (message, type = 'success') => {
    const id = ++idRef.current;
    setToasts(prev => {
      const next = [...prev, { id, message, type }];
      // FIFO eviction when full — drop oldest and cancel its dismiss timer.
      if (next.length > TOAST_MAX) {
        const evicted = next[0];
        const t = timersRef.current.get(evicted.id);
        if (t) { clearTimeout(t); timersRef.current.delete(evicted.id); }
        return next.slice(-TOAST_MAX);
      }
      return next;
    });
    const timer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      timersRef.current.delete(id);
    }, TOAST_TTL_MS);
    timersRef.current.set(id, timer);
  };

  // Clear any pending dismiss timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return { toasts, showToast };
};
