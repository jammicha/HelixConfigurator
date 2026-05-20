import React from 'react';
import { X, Loader2 } from 'lucide-react';
import type { SmartAddProposal } from '../../hooks/useSmartAdd';

type GatewayConfigModalProps = {
  open: boolean;
  text: string;
  onClose: () => void;
};

// Read-only YAML viewer opened from Step 2's "view gateway config" link.
// Full editing happens on the dashboard's YAML editor card.
export const GatewayConfigModal: React.FC<GatewayConfigModalProps> = ({ open, text, onClose }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div
        className="adapt-card !p-0 max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-800 bg-gray-900">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Gateway config</div>
            <div className="text-sm text-gray-200">Where the auth headers live</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="px-5 py-3 text-tiny text-gray-400 border-b border-gray-800 bg-gray-1000">
          Written automatically in Step 1. Your collector routes to the gateway receiver; the gateway authenticates to Helix via the highlighted headers.
        </div>
        <div className="flex-1 overflow-auto p-4 bg-gray-1000">
          <pre className="font-mono text-tiny text-gray-300 whitespace-pre" style={{ fontFamily: "'Source Code Pro', monospace" }}>
            {text
              ? text.split('\n').map((line, i) => {
                  const highlight = /(X-Api-Key|X-Source|endpoint:)/.test(line);
                  return (
                    <div key={i} className={highlight ? 'bg-warning/15 border-l-2 border-warning pl-2 -ml-2' : ''}>{line || ' '}</div>
                  );
                })
              : <span className="text-gray-500">Loading…</span>}
          </pre>
        </div>
        <footer className="px-5 py-3 border-t border-gray-800 bg-gray-900 flex justify-between items-center">
          <span className="text-tiny text-gray-500">Read-only here. Full editor available on the dashboard after launch.</span>
          <button
            onClick={onClose}
            className="text-tiny font-semibold text-gray-300 hover:text-gray-100"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
};

type SmartAddPreviewModalProps = {
  open: boolean;
  proposal: SmartAddProposal | null;
  applying: boolean;
  onClose: () => void;
  onApply: () => void;
  onCopyPath: (path: string) => void;
};

export const SmartAddPreviewModal: React.FC<SmartAddPreviewModalProps> = ({
  open,
  proposal,
  applying,
  onClose,
  onApply,
  onCopyPath,
}) => {
  if (!open || !proposal || !proposal.proposedYaml || !proposal.exporterName) return null;

  const exporterName = proposal.exporterName;
  const escapedName = exporterName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const declarationRe = new RegExp(`^(\\s*)${escapedName}:\\s*$`);
  const lines = proposal.proposedYaml.split('\n');
  let activeIndent = -1;
  const highlightFlags = lines.map((line) => {
    const decl = line.match(declarationRe);
    if (decl) {
      activeIndent = decl[1].length;
      return true;
    }
    if (activeIndent >= 0) {
      const m = line.match(/^(\s*)\S/);
      if (m && m[1].length > activeIndent) return true;
      activeIndent = -1;
    }
    return line.includes(exporterName);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={() => !applying && onClose()}>
      <div
        className="adapt-card !p-0 max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-800 bg-gray-900">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Smart-add preview</div>
            <div className="text-sm text-gray-200">{proposal.name} · <code className="font-mono text-gray-300">{proposal.configPath}</code></div>
            {proposal.hostConfigPath ? (
              <div className="mt-1.5 flex items-center gap-2 text-tiny text-gray-400">
                <span className="text-gray-500">Open locally:</span>
                <code className="font-mono text-gray-300 truncate" title={proposal.hostConfigPath}>{proposal.hostConfigPath}</code>
                <button
                  type="button"
                  onClick={() => onCopyPath(proposal.hostConfigPath!)}
                  className="text-active hover:underline font-semibold flex-shrink-0"
                >
                  Copy path
                </button>
              </div>
            ) : (
              <div className="mt-1.5 text-tiny text-gray-500">
                Config isn't bind-mounted from the host; it's baked into the image. No local path to open.
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={applying}
            className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800 disabled:opacity-50 flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="px-5 py-3 text-tiny text-gray-400 border-b border-gray-800 bg-gray-1000">
          Adding <code className="font-mono text-gray-200">{exporterName}</code> and wiring it into <strong className="text-gray-200">{(proposal.addedToPipelines || []).join(', ') || '(no pipelines)'}</strong>. Highlighted lines are what will change. The current file is backed up as <code className="font-mono">.helix-bak</code> in the container.
        </div>
        <div className="flex-1 overflow-auto p-4 bg-gray-1000">
          <pre className="font-mono text-tiny text-gray-300 whitespace-pre" style={{ fontFamily: "'Source Code Pro', monospace" }}>
            {lines.map((line, i) => (
              <div key={i} className={highlightFlags[i] ? 'bg-success/15 border-l-2 border-success pl-2 -ml-2' : ''}>{line || ' '}</div>
            ))}
          </pre>
        </div>
        <footer className="px-5 py-3 border-t border-gray-800 bg-gray-900 flex justify-between items-center gap-3">
          <span className="text-tiny text-gray-500">The collector container will restart on apply.</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={applying}
              className="text-tiny font-semibold text-gray-300 hover:text-gray-100 px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onApply}
              disabled={applying}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold bg-primary hover:bg-primary-hover disabled:opacity-60 text-white"
            >
              {applying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {applying ? 'Applying…' : 'Apply & restart'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
