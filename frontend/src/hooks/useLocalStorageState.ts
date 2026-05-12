import { useEffect, useRef, useState } from 'react';

/**
 * useState with localStorage write-through. Reads on mount (lazy initializer),
 * writes on every set. Falls back to `initial` when localStorage is empty or
 * the stored value fails the optional `validate` predicate — useful when a
 * stored enum is removed in a later build and we don't want to render with
 * a stale string.
 *
 * Storage failures (private mode, quota exceeded) are swallowed by design.
 * Page state persistence is a nice-to-have, not a correctness requirement.
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      if (validate && !validate(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial;
    }
  });

  // Track the key so renaming a stored slot doesn't write to the old slot.
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    try { localStorage.setItem(keyRef.current, JSON.stringify(value)); }
    catch { /* private mode / quota — non-fatal */ }
  }, [value]);

  return [value, setValue];
}
