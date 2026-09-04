import { useCallback, useEffect, useState } from 'react';

export type Signals = { traces: boolean; metrics: boolean; logs: boolean };
export type Connection = {
  id: string; name: string; endpoint: string; xSource: string;
  businessServiceKey: string; eventsEndpoint: string; signals: Signals; enabled: boolean;
};
export type Health = Record<string, { sent: number; failed: number; verdict: string }>;

export function useConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/connections');
      const data = await res.json();
      setConnections(data.connections || []);
      setActiveId(data.activeId ?? null);
      setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load connections'); }
    finally { setLoading(false); }
  }, []);

  const refreshHealth = useCallback(async () => {
    try { const res = await fetch('/api/connections/health'); setHealth(await res.json()); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { refresh(); refreshHealth(); }, [refresh, refreshHealth]);

  const send = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { errors: data.errors, status: res.status });
    return data;
  };

  return {
    connections, activeId, health, loading, error, refresh, refreshHealth,
    create: async (c: unknown) => { const d = await send('/api/connections', 'POST', c); await refresh(); return d; },
    update: async (id: string, c: unknown) => { const d = await send(`/api/connections/${id}`, 'PUT', c); await refresh(); return d; },
    remove: async (id: string) => { const d = await send(`/api/connections/${id}`, 'DELETE'); await refresh(); return d; },
    activate: async (id: string) => { const d = await send(`/api/connections/${id}/activate`, 'POST'); await refresh(); return d; },
    test: async (id: string) => send(`/api/connections/${id}/test`, 'POST'),
  };
}
