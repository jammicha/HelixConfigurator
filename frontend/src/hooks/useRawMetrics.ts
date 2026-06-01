import { useState } from 'react';

// Raw collector /metrics viewer modal: open-and-fetch, loading state, the
// relevant/all filter toggle, and the fetched text.
export const useRawMetrics = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<'relevant' | 'all'>('relevant');

  const open = async () => {
    setIsOpen(true);
    setIsLoading(true);
    try {
      const res = await fetch('/api/diagnostics/metrics/raw');
      setText(await res.text());
    } catch (err: any) {
      setText(`Failed to fetch metrics: ${err.message || err}`);
    } finally {
      setIsLoading(false);
    }
  };

  const close = () => setIsOpen(false);

  return { isOpen, text, isLoading, filter, setFilter, open, close };
};
