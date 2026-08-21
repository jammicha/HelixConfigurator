import { Loader2 } from 'lucide-react';

type DiagState = { status: string; error?: string; remediation?: string };

type Props = {
  collectorDiag: DiagState;
  apiKeyDiag: DiagState;
  networkDiag: DiagState;
  viewerDiag: DiagState;
  xSource: string;
  envLoaded: boolean;
  expandedRemediations: Record<number, boolean>;
  onToggleRemediation: (i: number) => void;
  onCopy: (text: string) => void;
};

type Check = { isPass: boolean; isChecking: boolean; subDetail: string; remediation: string };

// The five-cell diagnostic summary (Collector Configuration, X-API Key Format,
// X-Source Format, Tenant URL Endpoint, Local Viewer Fan-out) with per-cell
// pass/checking/fail state and an expandable remediation step.
export const DiagnosticChecksGrid = ({
  collectorDiag,
  apiKeyDiag,
  networkDiag,
  viewerDiag,
  xSource,
  envLoaded,
  expandedRemediations,
  onToggleRemediation,
  onCopy,
}: Props) => {
  const evaluate = (title: string): Check => {
    switch (title) {
      case 'Collector Configuration':
        return {
          isPass: collectorDiag.status === 'PASS',
          isChecking: collectorDiag.status === 'unknown' || collectorDiag.status === 'CHECKING',
          subDetail: collectorDiag.error || '',
          remediation: collectorDiag.remediation || '',
        };
      case 'X-API Key Format':
        return {
          isPass: apiKeyDiag.status === 'PASS',
          isChecking: apiKeyDiag.status === 'unknown',
          subDetail: apiKeyDiag.error || '',
          remediation: apiKeyDiag.remediation || '',
        };
      case 'X-Source Format': {
        const isPass = !!(xSource && xSource.length > 0);
        return {
          isPass,
          isChecking: !envLoaded,
          subDetail: '',
          remediation: isPass ? '' : 'X-Source is required to identify your telemetry data.',
        };
      }
      case 'Local Viewer Fan-out':
        return {
          isPass: viewerDiag.status === 'ok',
          isChecking: viewerDiag.status === 'unknown' || viewerDiag.status === 'CHECKING',
          subDetail: viewerDiag.error || '',
          remediation: viewerDiag.remediation || '',
        };
      default: // 'Tenant URL Endpoint'
        return {
          isPass: networkDiag.status === 'Success',
          isChecking: networkDiag.status === 'unknown',
          subDetail: networkDiag.error || '',
          remediation: networkDiag.remediation || '',
        };
    }
  };

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-4 text-gray-200">Helix troubleshooting & diagnostics</h2>
      <div className="grid grid-cols-5 gap-4">
        {['Collector Configuration', 'X-API Key Format', 'X-Source Format', 'Tenant URL Endpoint', 'Local Viewer Fan-out'].map((title, i) => {
          const { isPass, isChecking, subDetail, remediation } = evaluate(title);
          return (
            <div key={i} className="flex flex-col gap-2">
              <div className="bg-gray-800 border border-gray-700 p-4 rounded flex flex-col items-center justify-center gap-3 relative group min-h-[120px]">
                <span className="text-sm font-semibold text-gray-300 text-center">{title}</span>
                {isPass ? (
                  <span className="adapt-badge-success px-3 py-1 uppercase tracking-wider">
                    Pass
                  </span>
                ) : isChecking ? (
                  <div className="flex flex-col items-center gap-2">
                    <span className="flex items-center gap-2 px-3 py-1 uppercase tracking-wider text-xs font-semibold text-gray-400 bg-gray-800 border border-gray-700 rounded">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Checking
                    </span>
                    {subDetail && (
                      <span className="text-[10px] text-gray-400 font-medium text-center leading-tight">
                        {subDetail}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <span className="adapt-badge-danger px-3 py-1 uppercase tracking-wider">
                      Fail
                    </span>
                    {subDetail && (
                      <span className="text-[10px] text-danger-text font-medium text-center leading-tight">
                        {subDetail}
                      </span>
                    )}
                    {remediation && (
                      <button
                        onClick={() => onToggleRemediation(i)}
                        className="text-info text-[11px] font-bold hover:underline cursor-pointer bg-transparent border-none mt-1"
                      >
                        {expandedRemediations[i] ? 'Hide Fix' : 'View Fix'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {expandedRemediations[i] && remediation && (
                <div className="bg-gray-1000 border-l-2 border-danger p-3 rounded-r text-xs text-gray-200 animate-in fade-in slide-in-from-top-2 duration-200">
                  <div className="flex items-center justify-between mb-1">
                    <p className="font-bold text-danger-text uppercase tracking-tighter">Remediation Step:</p>
                    <button
                      onClick={() => onCopy(`[${title}] ${subDetail ? subDetail + '\n' : ''}${remediation}`)}
                      className="text-tiny text-info hover:underline uppercase tracking-wider font-semibold"
                      title="Copy remediation text for sharing"
                    >
                      Copy
                    </button>
                  </div>
                  {remediation}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
