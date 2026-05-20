import React from 'react';

export const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  countTone?: 'neutral' | 'danger';
  /** Optional second danger-toned pill rendered next to `count`. Used by the
   *  Logs & Errors tab to surface log count and error count separately. */
  errorCount?: number;
  /** When provided, the error pill becomes its own click target — useful
   *  when the parent wants to deep-link directly to the Errors sub-tab
   *  instead of the default (Logs). Click bubbling is stopped so the
   *  parent button's onClick doesn't also fire. */
  onErrorCountClick?: () => void;
}> = ({ active, onClick, icon, label, count, countTone = 'neutral', errorCount, onErrorCountClick }) => {
  const pillClass = (tone: 'neutral' | 'danger') =>
    `text-tiny px-1.5 py-0.5 rounded font-mono ${
      tone === 'danger'
        ? 'bg-danger/20 text-[#ff8a8a]'
        : active
          ? 'bg-active/20 text-[#a5baff]'
          : 'bg-gray-800 text-gray-400'
    }`;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
        active
          ? 'border-active text-gray-100'
          : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {icon}
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className={pillClass(countTone)} title="Logs">{count}</span>
      )}
      {typeof errorCount === 'number' && errorCount > 0 && (
        onErrorCountClick ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onErrorCountClick(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onErrorCountClick(); }
            }}
            className={`${pillClass('danger')} cursor-pointer hover:bg-danger/30`}
            title="Errors. Click to open the Errors sub-tab."
          >{errorCount}</span>
        ) : (
          <span className={pillClass('danger')} title="Errors">{errorCount}</span>
        )
      )}
    </button>
  );
};
