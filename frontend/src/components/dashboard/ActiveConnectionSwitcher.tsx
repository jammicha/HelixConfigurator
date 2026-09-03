import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useConnections } from '../../hooks/useConnections';

// Health dot colors mirror ManageConnectionsPage's verdict->color mapping so
// the two surfaces read as the same status language.
const healthDotClass = (verdict: string | undefined): string => {
  if (verdict === 'healthy') return 'bg-success-text';
  if (verdict === 'failing') return 'bg-danger-text';
  if (verdict === 'disabled') return 'bg-gray-700';
  return 'bg-gray-500'; // idle / unknown
};

const healthLabel = (verdict: string | undefined): string => {
  if (verdict === 'healthy') return 'Healthy';
  if (verdict === 'failing') return 'Failing';
  if (verdict === 'disabled') return 'Disabled';
  if (verdict === 'idle') return 'Idle';
  return 'Unknown';
};

interface ActiveConnectionSwitcherProps {
  // Called after a successful activate so the caller can refresh anything
  // App-level that depends on which connection is active (e.g. the cached
  // .env values used for external deep links). Optional; the dropdown
  // itself already reflects the new active connection via the hook's own
  // refresh.
  onActivated?: () => void;
}

// Header-style control for the (now optional) one-tenant dashboard: renders
// nothing until a second connection exists, so single-tenant setups are
// visually unchanged. With 2+ connections it shows the active connection's
// name and lets the user switch which one is active without recreating the
// gateway (activation is a fast server-side call).
export const ActiveConnectionSwitcher: React.FC<ActiveConnectionSwitcherProps> = ({ onActivated }) => {
  const { connections, activeId, health, activate } = useConnections();
  const [open, setOpen] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Single-tenant (0 or 1 connection): don't add any chrome to the dashboard.
  if (connections.length <= 1) return null;

  const active = connections.find((c) => c.id === activeId) || null;

  const handleSelect = async (id: string) => {
    if (id === activeId || activatingId) return;
    setActivatingId(id);
    setSwitchError('');
    try {
      await activate(id);
      setOpen(false);
      onActivated?.();
    } catch (e: any) {
      setSwitchError(e?.message || 'Failed to switch connection');
    } finally {
      setActivatingId(null);
    }
  };

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        aria-label="Switch active connection"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-gray-800 hover:border-active text-sm text-gray-200 bg-gray-1000 transition-colors"
      >
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${healthDotClass(health[activeId || '']?.verdict)}`}
          aria-hidden="true"
        />
        <span className="font-semibold truncate max-w-[14rem]">{active?.name || 'Select connection'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-72 bg-gray-1000 border border-gray-800 rounded shadow-3 py-1 z-50">
          <div className="px-3 py-2 text-tiny font-semibold text-gray-500 uppercase tracking-wider">
            Active connection
          </div>
          <ul>
            {connections.map((c) => {
              const isActive = c.id === activeId;
              const isBusy = activatingId === c.id;
              const h = health[c.id];
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(c.id)}
                    disabled={isBusy}
                    aria-current={isActive}
                    className={`w-full text-left flex items-center gap-2 px-3 py-2 text-sm transition-colors disabled:opacity-60 ${
                      isActive
                        ? 'bg-primary/15 text-white font-semibold border-l-2 border-primary -ml-px pl-[10px]'
                        : 'text-gray-200 hover:bg-gray-900 hover:text-white'
                    }`}
                  >
                    {isBusy ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-400 flex-shrink-0" />
                    ) : (
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${healthDotClass(h?.verdict)}`}
                        title={`Health: ${healthLabel(h?.verdict)}`}
                        aria-label={`Health: ${healthLabel(h?.verdict)}`}
                      />
                    )}
                    <span className="truncate">{c.name}</span>
                    {isActive && <span className="adapt-badge-info ml-auto">Active</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {switchError && (
            <div className="px-3 py-2 text-tiny text-danger-text">{switchError}</div>
          )}
        </div>
      )}
    </div>
  );
};
