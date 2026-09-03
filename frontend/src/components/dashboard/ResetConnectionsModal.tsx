import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import { useConnections, type Connection } from '../../hooks/useConnections';
import { computeResetMode } from './resetMode';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedIds: string[]) => void;
  resetting?: boolean;
};

const FULL_RESET_WARNING =
  'This clears your Helix endpoint, API key, X-Source, and Business Service key from .env, drops any bridged networks the gateway is on, and recreates the gateway with empty values. The OTel trace store and your gateway YAML config are left alone. You\'ll land back on Step 1.';

// Reset flow now supports resetting a subset of connections rather than
// always wiping everything. Every connection selected (or none selected, to
// match the old one-click behavior) is a full reset; a strict subset is a
// partial reset that only removes the selected connections and leaves the
// wizard state alone. computeResetMode mirrors the backend's own decision so
// the warning copy the user sees always matches what actually happens.
export const ResetConnectionsModal: React.FC<Props> = ({ isOpen, onClose, onConfirm, resetting = false }) => {
  const { connections, activeId } = useConnections();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Default to "select all" (today's one-click full reset) each time the
  // modal opens, so existing single-connection setups behave exactly as
  // before with no extra clicks.
  useEffect(() => {
    if (isOpen) setSelectedIds(connections.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEscClose(isOpen, onClose);

  const allIds = useMemo(() => connections.map((c) => c.id), [connections]);
  const mode = computeResetMode(selectedIds, allIds);
  const allSelected = allIds.length > 0 && selectedIds.length === allIds.length;

  if (!isOpen) return null;

  const toggle = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : allIds);
  };

  const survivors = connections.filter((c) => !selectedIds.includes(c.id));
  const removedActive = selectedIds.includes(activeId || '');
  // After removing the selected connections, the backend picks a new active
  // connection when the current active one was among those removed. Mirror
  // that here (first surviving connection) purely for the warning copy;
  // the backend response is still the source of truth for what actually
  // becomes active.
  const nextActive = removedActive ? survivors[0] : connections.find((c) => c.id === activeId);

  const partialWarning = (() => {
    const removedNames = connections.filter((c) => selectedIds.includes(c.id)).map((c) => c.name);
    const namesText = removedNames.length ? removedNames.join(', ') : 'the selected connections';
    if (survivors.length === 0) {
      return `${namesText} will stop receiving telemetry and be removed.`;
    }
    const activeText = nextActive ? `"${nextActive.name}" will remain the active connection.` : '';
    return `${namesText} will stop receiving telemetry and be removed. ${activeText}`.trim();
  })();

  const confirmDisabled = resetting || selectedIds.length === 0;

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-connections-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <h2 id="reset-connections-modal-title" className="text-lg font-semibold text-gray-200">
            Reset onboarding
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close reset dialog">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <p className="text-sm text-gray-400">
            Choose which connections to reset. Selecting all (the default) fully resets onboarding; selecting fewer
            removes just those connections.
          </p>

          <label className="flex items-center gap-2 px-3 py-2 rounded border border-gray-800 bg-gray-1000 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label="Select all connections (full reset)"
            />
            <span className="text-sm font-semibold text-gray-200">Select all (full reset)</span>
          </label>

          <ul className="space-y-1.5">
            {connections.map((c: Connection) => {
              const checked = selectedIds.includes(c.id);
              const isActive = c.id === activeId;
              return (
                <li key={c.id}>
                  <label className="flex items-center gap-2 px-3 py-2 rounded border border-gray-800 hover:border-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c.id)}
                      aria-label={`Select connection ${c.name}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-200 truncate">{c.name}</span>
                      <span className="block text-tiny text-gray-500 truncate font-mono">{c.endpoint}</span>
                    </span>
                    {isActive && <span className="adapt-badge-info flex-shrink-0">Active</span>}
                  </label>
                </li>
              );
            })}
            {connections.length === 0 && (
              <li className="text-sm text-gray-500 px-3 py-2">No connections configured.</li>
            )}
          </ul>

          <div
            className={`text-sm rounded border px-3 py-2 leading-relaxed ${
              mode === 'full'
                ? 'border-danger/40 bg-danger/10 text-danger-text'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
            role="status"
          >
            {mode === 'full' ? FULL_RESET_WARNING : partialWarning}
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <button
            onClick={onClose}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-2 rounded font-semibold text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selectedIds)}
            disabled={confirmDisabled}
            className="bg-primary hover:bg-[#3006c2] disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded font-semibold text-sm"
          >
            {mode === 'full' ? 'Reset' : 'Reset selected'}
          </button>
        </div>
      </div>
    </div>
  );
};
