import React from 'react';

export type Toast = { id: number; message: string; type: 'success' | 'error' };

type Props = { toasts: Toast[] };

export const ToastStack: React.FC<Props> = ({ toasts }) => (
  <div
    className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 items-end pointer-events-none"
    role="status"
    aria-live="polite"
    aria-atomic="false"
  >
    {toasts.map(t => (
      <div
        key={t.id}
        className={`px-5 py-3 rounded shadow-3 font-semibold text-sm text-white transition-all pointer-events-auto ${t.type === 'error' ? 'bg-danger' : 'bg-success'}`}
      >
        {t.message}
      </div>
    ))}
  </div>
);
