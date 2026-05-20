import React from 'react';
import { RefreshCw, Stethoscope, ClipboardList, Boxes, Loader2 } from 'lucide-react';

type Props = {
  onReverifyTelemetry: () => void;
  onToggleDiagnostics: () => void;
  onCopySupportBundle: () => void;
  onOpenServices: () => void;

  // Diagnostic toggle state — drives label + active styling + disabled gating.
  showDiagnostics: boolean;
  isTogglingDiag: boolean;
  isDiagnosticEnabled: boolean;

  // Services toggle state — label + active styling.
  isServicesOpen: boolean;
};

export const QuickActions: React.FC<Props> = ({
  onReverifyTelemetry,
  onToggleDiagnostics,
  onCopySupportBundle,
  onOpenServices,
  showDiagnostics,
  isTogglingDiag,
  isDiagnosticEnabled,
  isServicesOpen,
}) => {
  const baseBtn =
    'border py-2.5 px-3 rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
  const idle = 'bg-gray-1000 hover:bg-gray-900 border-gray-800 text-gray-200';
  const active = 'bg-primary border-primary text-white hover:bg-primary-hover';
  const danger = 'bg-danger border-danger text-white hover:bg-[#890008]';

  const diagDisabled = (!isDiagnosticEnabled && !showDiagnostics) || isTogglingDiag;

  return (
    <div className="adapt-card">
      <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">Quick actions</div>
      <div className="grid grid-cols-4 gap-3">
        <button onClick={onReverifyTelemetry} className={`${baseBtn} ${idle}`}>
          <RefreshCw className="w-4 h-4" /> Re-verify telemetry
        </button>
        <button
          onClick={onToggleDiagnostics}
          disabled={diagDisabled}
          title={!isDiagnosticEnabled && !showDiagnostics ? 'Connect to the Helix Gateway to enable diagnostics' : undefined}
          className={`${baseBtn} ${showDiagnostics ? danger : isDiagnosticEnabled ? active : idle}`}
        >
          {isTogglingDiag ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
          {isTogglingDiag
            ? (showDiagnostics ? 'Closing…' : 'Starting…')
            : (showDiagnostics ? 'Close diagnostic' : 'Run diagnostic')}
        </button>
        <button onClick={onCopySupportBundle} className={`${baseBtn} ${idle}`}>
          <ClipboardList className="w-4 h-4" /> Copy support bundle
        </button>
        <button onClick={onOpenServices} className={`${baseBtn} ${isServicesOpen ? active : idle}`}>
          <Boxes className="w-4 h-4" /> {isServicesOpen ? 'Hide services' : 'Discovered services'}
        </button>
      </div>
    </div>
  );
};
