import React, { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { BmcChevron } from './BmcChevron';
import { buildHelixBusinessServiceUrl } from './utils';
import type { HelixEnv } from './types';

type Props = {
  helixEnv: HelixEnv | null;
};

export const HelixCtaBanner: React.FC<Props> = ({ helixEnv }) => {
  const [dismissed, setDismissed] = useState(false);
  const url = buildHelixBusinessServiceUrl(helixEnv);
  if (!url || dismissed) return null;

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded border border-[#FF5A4D]/30 bg-[#FF5A4D]/5 px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <BmcChevron className="h-5 w-auto shrink-0" />
        <div className="text-tiny text-gray-200 truncate">
          <span className="font-semibold text-white">Telemetry is flowing.</span>{' '}
          <span className="text-gray-400">
            For full anomaly detection, root-cause analysis, and historical depth, continue in Helix AIOps.
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-gray-800 hover:border-[#FF5A4D] text-tiny uppercase tracking-wider font-semibold text-gray-300 hover:text-white transition-colors"
        >
          Open in Helix AIOps
          <ExternalLink className="w-4 h-4 opacity-70" />
        </a>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="text-gray-500 hover:text-gray-200 p-1 rounded hover:bg-gray-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
