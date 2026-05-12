import React from 'react';

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

type Props = {
  request: ConfirmRequest | null;
  onCancel: () => void;
};

export const ConfirmDialog: React.FC<Props> = ({ request, onCancel }) => {
  if (!request) return null;
  return (
    <div
      className="fixed inset-0 z-[300] bg-black/70 flex items-center justify-center p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-md p-5 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-gray-200">{request.title}</h2>
        <p className="text-sm text-gray-300 leading-relaxed">{request.message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-2 rounded font-semibold text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => { const cb = request.onConfirm; onCancel(); cb(); }}
            className="bg-primary hover:bg-[#3006c2] text-white px-4 py-2 rounded font-semibold text-sm"
            autoFocus
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
