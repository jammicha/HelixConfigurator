import React from 'react';
import { ArrowLeft, LayoutDashboard } from 'lucide-react';
import { LinkBusinessService } from '../business-service/LinkBusinessService';

type Props = {
  onBack: () => void;
  onFinish: () => void;
  currentKey?: string;
  onCaptured?: (key: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
};

export const Step5: React.FC<Props> = ({ onBack, onFinish, currentKey, onCaptured, onToast }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 5: Link to a Business Service</h2>
    <p className="text-sm text-gray-400 mb-4">
      Optional but recommended — associate your telemetry with a Business Service so AIOps rolls up health and Situations. You can also do this later from the dashboard.
    </p>
    <LinkBusinessService context="wizard" currentKey={currentKey} onCaptured={onCaptured} onToast={onToast} />
    <div className="flex items-center justify-between mt-5">
      <button onClick={onBack} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-2 rounded font-semibold text-sm flex items-center gap-2">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <button onClick={onFinish} className="bg-primary hover:bg-[#3006c2] text-white px-4 py-2 rounded font-semibold text-sm flex items-center gap-2">
        <LayoutDashboard className="w-4 h-4" /> Finish &amp; open dashboard
      </button>
    </div>
  </div>
);
