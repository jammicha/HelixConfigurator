import { useCallback, useRef } from 'react';
import { createPollGuard, type PollGuard } from './pollGuard';

/**
 * Wrap a refresh function so that, invoked as a *periodic poll*, it skips its
 * turn while a previous invocation is still in flight (see `createPollGuard`).
 *
 * The returned function identity is stable, and it always calls the latest `fn`
 * (captured via a ref), so passing an inline/closure refresh is fine — no
 * interval churn. User-initiated refreshes (filter/search changes) should call
 * the raw function directly so they always run; only interval/cadence call sites
 * use this guarded wrapper.
 */
export function useGuardedPoll(fn: () => void | Promise<unknown>): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const guardRef = useRef<PollGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createPollGuard();
  return useCallback(() => { guardRef.current!.run(() => fnRef.current()); }, []);
}
