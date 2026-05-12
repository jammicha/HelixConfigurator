import React from 'react';

export const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  countTone?: 'neutral' | 'danger';
}> = ({ active, onClick, icon, label, count, countTone = 'neutral' }) => (
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
      <span
        className={`text-tiny px-1.5 py-0.5 rounded font-mono ${
          countTone === 'danger'
            ? 'bg-danger/20 text-[#ff8a8a]'
            : active
              ? 'bg-active/20 text-[#a5baff]'
              : 'bg-gray-800 text-gray-400'
        }`}
      >
        {count}
      </span>
    )}
  </button>
);
