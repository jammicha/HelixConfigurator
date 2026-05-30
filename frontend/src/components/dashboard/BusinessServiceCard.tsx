import React from 'react';
import { LinkBusinessService } from '../business-service/LinkBusinessService';

type Props = {
  currentKey?: string;
  onCaptured?: (key: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
};

export const BusinessServiceCard: React.FC<Props> = ({ currentKey, onCaptured, onToast }) => (
  <div className="adapt-card">
    <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">Business Service</div>
    <LinkBusinessService context="dashboard" currentKey={currentKey} onCaptured={onCaptured} onToast={onToast} />
  </div>
);
