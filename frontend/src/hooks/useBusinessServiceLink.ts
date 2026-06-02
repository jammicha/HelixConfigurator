import { useState, useCallback } from 'react';

export type NamespaceRow = { namespace: string; traceCount: number; lastSeen: number; fallback: boolean };
export type BindInstructions = { namespace: string; steps: string[]; aiopsUrl: string; dashboardUrl: string; blueprintLabel?: string; blueprintDocsUrl?: string };

export type UseBusinessServiceLink = {
  namespaces: NamespaceRow[];
  loadingNamespaces: boolean;
  instructions: BindInstructions | null;
  loadingInstructions: boolean;
  saving: boolean;
  savedKey: string | null;
  error: string;
  loadNamespaces: () => Promise<void>;
  loadInstructions: (namespace: string) => Promise<void>;
  persistKey: (input: string) => Promise<string | null>;
  reset: () => void;
};

export function useBusinessServiceLink(): UseBusinessServiceLink {
  const [namespaces, setNamespaces] = useState<NamespaceRow[]>([]);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [instructions, setInstructions] = useState<BindInstructions | null>(null);
  const [loadingInstructions, setLoadingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadNamespaces = useCallback(async () => {
    setLoadingNamespaces(true); setError('');
    try {
      const res = await fetch('/api/business-service/namespaces');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load namespaces'); return; }
      setNamespaces(Array.isArray(data.namespaces) ? data.namespaces : []);
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoadingNamespaces(false); }
  }, []);

  const loadInstructions = useCallback(async (namespace: string) => {
    setLoadingInstructions(true); setError('');
    try {
      const res = await fetch(`/api/business-service/bind-instructions?namespace=${encodeURIComponent(namespace)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load instructions'); return; }
      setInstructions(data as BindInstructions);
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoadingInstructions(false); }
  }, []);

  const persistKey = useCallback(async (input: string): Promise<string | null> => {
    if (saving) return null;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/business-service/persist-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not save key'); return null; }
      setSavedKey(data.businessServiceKey || '');
      return data.businessServiceKey || '';
    } catch (e: any) { setError(e?.message || 'Network error'); return null; }
    finally { setSaving(false); }
  }, [saving]);

  const reset = useCallback(() => { setInstructions(null); setSavedKey(null); setError(''); }, []);

  return { namespaces, loadingNamespaces, instructions, loadingInstructions, saving, savedKey, error, loadNamespaces, loadInstructions, persistKey, reset };
}
