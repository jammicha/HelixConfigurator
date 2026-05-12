import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';

type Props = {
  onLogin: (password: string) => Promise<{ ok: boolean; error?: string }>;
};

export const LoginScreen: React.FC<Props> = ({ onLogin }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const result = await onLogin(password);
    if (!result.ok) setError(result.error || 'Invalid password');
    else setPassword('');
    setSubmitting(false);
  };

  return (
    <div className="flex items-center justify-center h-screen w-full bg-gray-900">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-1000 border border-gray-800 rounded-lg shadow-4 p-8 w-full max-w-md space-y-5"
      >
        <div className="flex items-center gap-3">
          <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
          <h1 className="text-white font-semibold text-xl">Helix OTel Configurator</h1>
        </div>
        <div className="space-y-1">
          <label htmlFor="login-password" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Password</label>
          <input
            id="login-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
            placeholder="Enter shared access password"
          />
        </div>
        {error && (
          <div className="flex gap-3 p-3 bg-[#f5bcc6]/20 border border-danger/40 rounded text-sm items-start" role="alert">
            <X className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" aria-label="Error" />
            <span className="text-gray-300">{error}</span>
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded font-semibold transition-all flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
};
