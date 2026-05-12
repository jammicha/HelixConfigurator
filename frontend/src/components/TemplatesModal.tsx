import React from 'react';
import { Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';

export type Template = { id: string; name: string; description: string };

type Props = {
  isOpen: boolean;
  templates: Template[];
  loadingTemplateId: string | null;
  onApply: (id: string) => void;
  onClose: () => void;
};

export const TemplatesModal: React.FC<Props> = ({ isOpen, templates, loadingTemplateId, onApply, onClose }) => {
  useEscClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="templates-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="templates-modal-title" className="text-lg font-semibold text-gray-200">Configuration templates</h2>
            <p className="text-tiny text-gray-500">Loading a template replaces the editor contents — click Save Config after to apply.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close templates dialog">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {templates.length === 0 ? (
            <div className="flex items-center gap-2 text-gray-500 p-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading templates...
            </div>
          ) : templates.map(t => (
            <div key={t.id} className="bg-gray-1000 border border-gray-800 hover:border-active p-4 rounded transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-gray-200 text-sm">{t.name}</h3>
                  <p className="text-xs text-gray-400 mt-1">{t.description}</p>
                </div>
                <button
                  onClick={() => onApply(t.id)}
                  disabled={loadingTemplateId !== null}
                  className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors flex items-center gap-2 flex-shrink-0"
                >
                  {loadingTemplateId === t.id && <Loader2 className="w-3 h-3 animate-spin" />}
                  Use template
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
