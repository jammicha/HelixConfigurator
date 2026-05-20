import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

type Phase =
  | { kind: 'form'; error: string | null }
  | { kind: 'submitting' }
  | { kind: 'waiting'; secondsLeft: number }
  | { kind: 'failed'; message: string };

// 'set' shows the new-password form. 'remove' shows a confirmation copy
// for clearing the existing password and reopening the UI. Both paths
// converge on the same submit → wait-for-restart → reload UX.
export type SetPasswordMode = 'set' | 'remove';

type Props = {
  open: boolean;
  mode: SetPasswordMode;
  // Whether a password is currently set (drives copy: "Set" vs "Change").
  // Only meaningful when mode === 'set'.
  hasExistingPassword: boolean;
  onClose: () => void;
};

const MIN_LEN = 8;
const POLL_TIMEOUT_MS = 30_000;

export const SetPasswordModal: React.FC<Props> = ({ open, mode, hasExistingPassword, onClose }) => {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form', error: null });
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset form state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPw1('');
    setPw2('');
    setShow(false);
    setPhase({ kind: 'form', error: null });
    // Focus the first input on open.
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // ESC closes (only when form is editable — don't dismiss mid-restart).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase.kind === 'form') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase.kind, onClose]);

  if (!open) return null;

  const submitWithPassword = async (password: string | null) => {
    if (password !== null) {
      if (password.length < MIN_LEN) {
        setPhase({ kind: 'form', error: `Password must be at least ${MIN_LEN} characters.` });
        return;
      }
      if (password !== pw2) {
        setPhase({ kind: 'form', error: "Passwords don't match." });
        return;
      }
    }
    setPhase({ kind: 'submitting' });
    try {
      const r = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // Empty string disables auth; non-empty sets the new password.
        body: JSON.stringify({ password: password ?? '' }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      // Server has accepted the change and is restarting. Begin polling
      // health until it returns. The OLD process answers /api/health while
      // it's still alive — we explicitly require seeing a network error
      // first (the restart has begun) before treating success as "back up."
      await waitForRestart(setPhase);
      // Server is back. Reload — the SPA reads the new auth state on boot.
      window.location.reload();
    } catch (e) {
      setPhase({ kind: 'failed', message: (e as Error).message });
    }
  };

  const submitSet = () => submitWithPassword(pw1);
  const submitRemove = () => submitWithPassword(null);

  const onPw1Key = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') inputRef.current?.parentElement?.parentElement?.querySelector<HTMLInputElement>('input[name="confirm"]')?.focus();
  };
  const onPw2Key = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submitSet();
  };

  const dismissible = phase.kind === 'form' || phase.kind === 'failed';
  const title = mode === 'remove'
    ? 'Remove UI password'
    : hasExistingPassword ? 'Change UI password' : 'Set UI password';

  return (
    <>
      <div
        onClick={dismissible ? onClose : undefined}
        className={`fixed inset-0 bg-black/50 z-40 ${dismissible ? '' : 'pointer-events-none'}`}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div className="w-full max-w-md bg-gray-1000 border border-gray-800 rounded-lg shadow-4 pointer-events-auto">
          <header className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
            {dismissible && (
              <button
                onClick={onClose}
                className="p-1 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-900"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </header>

          <div className="p-5">
            {(phase.kind === 'form' || phase.kind === 'submitting') && mode === 'set' && (
              <>
                <p className="text-sm text-gray-400 mb-4 leading-relaxed">
                  {hasExistingPassword
                    ? 'Replace the current sign-in password. All active sessions will be signed out and the configurator will restart to apply the change.'
                    : 'Require a password to access this UI. The configurator will restart to apply the change, then you’ll be prompted to sign in.'}
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider block mb-1">New password</label>
                    <div className="relative">
                      <input
                        ref={inputRef}
                        type={show ? 'text' : 'password'}
                        name="newPassword"
                        value={pw1}
                        onChange={(e) => setPw1(e.target.value)}
                        onKeyDown={onPw1Key}
                        disabled={phase.kind === 'submitting'}
                        className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm disabled:opacity-60"
                        placeholder={`At least ${MIN_LEN} characters`}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShow((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
                      >
                        {show ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider block mb-1">Confirm new password</label>
                    <input
                      type={show ? 'text' : 'password'}
                      name="confirm"
                      value={pw2}
                      onChange={(e) => setPw2(e.target.value)}
                      onKeyDown={onPw2Key}
                      disabled={phase.kind === 'submitting'}
                      className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm disabled:opacity-60"
                      placeholder="Re-enter the password"
                      autoComplete="new-password"
                    />
                  </div>
                </div>

                {phase.kind === 'form' && phase.error && (
                  <div className="mt-3 text-tiny text-danger inline-flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" /> {phase.error}
                  </div>
                )}
              </>
            )}

            {(phase.kind === 'form' || phase.kind === 'submitting') && mode === 'remove' && (
              <div className="space-y-3">
                <div className="rounded border border-warning/40 bg-warning/10 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-gray-200 leading-relaxed">
                    Removing the password reopens this UI to anyone with network access to the URL. The configurator will restart to apply.
                  </div>
                </div>
                <p className="text-sm text-gray-400 leading-relaxed">
                  All active sessions will be signed out. If you change your mind later, set a new password from the avatar menu.
                </p>
              </div>
            )}

            {phase.kind === 'waiting' && (
              <div className="flex items-start gap-3">
                <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-100">Restarting configurator…</div>
                  <div className="text-sm text-gray-400 mt-1 leading-relaxed">
                    {mode === 'set'
                      ? 'The new password is saved. Waiting for the server to come back up — this usually takes about 10 seconds. The page will reload automatically when it’s ready.'
                      : 'Password removed. Waiting for the server to come back up — this usually takes about 10 seconds. The page will reload automatically when it’s ready.'}
                  </div>
                  <div className="text-tiny text-gray-500 mt-2">Up to {Math.ceil(phase.secondsLeft)}s remaining</div>
                </div>
              </div>
            )}

            {phase.kind === 'failed' && (
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-100">Restart didn’t complete</div>
                  <div className="text-sm text-gray-400 mt-1 leading-relaxed">
                    {phase.message}
                  </div>
                  <div className="text-tiny text-gray-500 mt-2">
                    Refresh the page manually. The server may still be coming back up.
                  </div>
                </div>
              </div>
            )}
          </div>

          {(phase.kind === 'form' || phase.kind === 'submitting') && (
            <footer className="px-5 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button
                onClick={onClose}
                disabled={phase.kind === 'submitting'}
                className="px-4 py-2 rounded font-semibold text-sm text-gray-300 hover:text-gray-100 hover:bg-gray-900 disabled:opacity-60 transition-colors"
              >
                Cancel
              </button>
              {mode === 'set' ? (
                <button
                  onClick={submitSet}
                  disabled={phase.kind === 'submitting' || pw1.length === 0 || pw2.length === 0}
                  className="bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-5 py-2 rounded font-semibold transition-all text-sm flex items-center gap-2"
                >
                  {phase.kind === 'submitting' && <Loader2 className="w-4 h-4 animate-spin" />}
                  {phase.kind === 'submitting'
                    ? 'Saving…'
                    : (hasExistingPassword ? 'Save and restart' : 'Set password and restart')}
                </button>
              ) : (
                <button
                  onClick={submitRemove}
                  disabled={phase.kind === 'submitting'}
                  className="bg-danger hover:bg-[#890008] disabled:opacity-60 disabled:cursor-not-allowed text-white px-5 py-2 rounded font-semibold transition-all text-sm flex items-center gap-2"
                >
                  {phase.kind === 'submitting' && <Loader2 className="w-4 h-4 animate-spin" />}
                  {phase.kind === 'submitting' ? 'Removing…' : 'Remove and restart'}
                </button>
              )}
            </footer>
          )}

          {phase.kind === 'failed' && (
            <footer className="px-5 py-4 border-t border-gray-800 flex justify-end">
              <button
                onClick={() => window.location.reload()}
                className="bg-primary hover:bg-primary-hover text-white px-5 py-2 rounded font-semibold text-sm"
              >
                Reload page
              </button>
            </footer>
          )}
        </div>
      </div>
    </>
  );
};

// Poll /api/health until the server comes back up. Requires a "death gap"
// (at least one network-error reply) before treating success as "back up,"
// otherwise the old process responding to our first probe before the
// restart fires would race us into a premature reload.
async function waitForRestart(setPhase: (p: Phase) => void): Promise<void> {
  const start = Date.now();
  let sawDeath = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const elapsed = Date.now() - start;
    setPhase({ kind: 'waiting', secondsLeft: (POLL_TIMEOUT_MS - elapsed) / 1000 });
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        if (sawDeath) return; // Back up after death — done.
        // Still alive; keep polling to detect the death.
      } else {
        sawDeath = true;
      }
    } catch {
      sawDeath = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not come back within 30 seconds.');
}
