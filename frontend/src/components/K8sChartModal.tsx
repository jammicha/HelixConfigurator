import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { K8sChartPanel } from './K8sChartPanel';

type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — dashboard re-entry. Dialog chrome around the
// shared K8sChartPanel (the same panel the onboarding wizard's Kubernetes step uses).
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  const [namespace, setNamespace] = useState('default');
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="k8s-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="k8s-modal-title" className="text-lg font-semibold text-gray-200">Generate Kubernetes deployment</h2>
            <p className="text-tiny text-gray-500">A self-contained Helm chart, pre-wired to Helix from your current config.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close dialog">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <K8sChartPanel namespace={namespace} onNamespaceChange={setNamespace} />
        </div>
      </div>
    </div>
  );
};
