import React from 'react';
import { Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';

const RAW_METRICS_RELEVANT_PREFIXES = [
  'otelcol_receiver_accepted_',
  'otelcol_receiver_refused_',
  'otelcol_processor_',
  'otelcol_exporter_sent_',
  'otelcol_exporter_send_failed_',
  'otelcol_exporter_queue_',
  'otelcol_exporter_enqueue_failed_',
];

const filterRelevant = (text: string): string =>
  text
    .split('\n')
    .filter(line => RAW_METRICS_RELEVANT_PREFIXES.some(p => line.startsWith(p)))
    .join('\n') || '(no relevant metric lines found — try All Metrics)';

type Props = {
  isOpen: boolean;
  text: string;
  isLoading: boolean;
  filter: 'relevant' | 'all';
  onSetFilter: (filter: 'relevant' | 'all') => void;
  onRefresh: () => void;
  onCopy: (filtered: string) => void;
  onClose: () => void;
};

export const RawMetricsModal: React.FC<Props> = ({ isOpen, text, isLoading, filter, onSetFilter, onRefresh, onCopy, onClose }) => {
  useEscClose(isOpen, onClose);
  if (!isOpen) return null;
  const display = filter === 'all' ? text : filterRelevant(text);
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="raw-metrics-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="raw-metrics-modal-title" className="text-lg font-semibold text-gray-200">Raw collector metrics</h2>
            <p className="text-tiny text-gray-500">Direct output from <span className="font-mono">helix-gateway:8888/metrics</span></p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close raw metrics dialog">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-800 flex-shrink-0">
          <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Filter:</span>
          <button
            onClick={() => onSetFilter('relevant')}
            className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${filter === 'relevant' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            Relevant Only
          </button>
          <button
            onClick={() => onSetFilter('all')}
            className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${filter === 'all' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            All Metrics
          </button>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline disabled:opacity-50"
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              onClick={() => onCopy(display)}
              disabled={!text || isLoading}
              className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline disabled:opacity-50"
            >
              Copy
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 bg-gray-1000 font-mono text-tiny text-gray-300 whitespace-pre" style={{ fontFamily: "'Source Code Pro', monospace" }}>
          {isLoading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading metrics...
            </div>
          ) : (
            display || '(empty response)'
          )}
        </div>
      </div>
    </div>
  );
};
