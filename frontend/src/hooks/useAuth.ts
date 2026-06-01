import { useEffect, useState } from 'react';

export type AuthStatus = { required: boolean; authenticated: boolean } | null;

// Auth gate: checks /api/auth/status on mount and exposes login/logout. While
// authStatus is null the app should show a loading state; the rest of the UI
// gates on required/authenticated.
export const useAuth = () => {
  const [authStatus, setAuthStatus] = useState<AuthStatus>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(data => setAuthStatus(data))
      .catch(() => setAuthStatus({ required: true, authenticated: false }));
  }, []);

  const performLogin = async (password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthStatus({ required: true, authenticated: true });
        return { ok: true };
      }
      return { ok: false, error: 'Invalid password' };
    } catch {
      return { ok: false, error: 'Login request failed' };
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthStatus({ required: true, authenticated: false });
  };

  return { authStatus, performLogin, handleLogout };
};
