import { Settings } from 'lucide-react';
import { NavAvatar } from './NavAvatar';

type AuthStatus = { required: boolean; authenticated: boolean };

type Props = {
  isSetupComplete: boolean;
  onJumpToOnboarding: () => void;
  onJumpToDashboard: () => void;
  onOpenSettings: () => void;
  authStatus: AuthStatus;
  onLogout: () => void;
  onOpenSetPassword: () => void;
  onRemovePassword: () => void;
  externalApps: { otelDashboardUrl: string | null; aiopsServiceUrl: string | null };
};

// Top navigation bar: product wordmark, primary section nav (Onboarding /
// Gateway Dashboard / View OTel Data), the settings gear (post-onboarding),
// and the account avatar menu.
export const AppHeader = ({
  isSetupComplete,
  onJumpToOnboarding,
  onJumpToDashboard,
  onOpenSettings,
  authStatus,
  onLogout,
  onOpenSetPassword,
  onRemovePassword,
  externalApps,
}: Props) => (
  <header className="bg-helixNav flex items-center px-5 h-14 font-helix w-full flex-shrink-0 sticky top-0 z-40 border-b border-[#3a3f4a]">
    <div className="flex items-center gap-4">
      <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
      <h1 className="text-white font-normal text-[1.1875rem] m-0 tracking-normal">Helix OTel Configurator</h1>
    </div>
    <nav className="flex items-center gap-7 text-sm text-[#cfd3da] ml-10">
      <button
        onClick={onJumpToOnboarding}
        className={!isSetupComplete
          ? 'text-white font-semibold border-b-2 border-primary pb-0.5 cursor-default'
          : 'hover:text-white transition-colors'}
      >
        Onboarding
      </button>
      <a
        href="/"
        onClick={(e) => {
          // Already on / — short-circuit the navigation. If we're on the
          // wizard but already onboarded, just flip to dashboard view.
          e.preventDefault();
          onJumpToDashboard();
        }}
        className={isSetupComplete
          ? 'text-white font-semibold border-b-2 border-primary pb-0.5 cursor-default'
          : 'hover:text-white transition-colors'}
      >
        Gateway Dashboard
      </a>
      <a
        href="/otel-data"
        className="hover:text-white transition-colors"
      >
        View OTel Data
      </a>
      <a
        href="/connections"
        className="hover:text-white transition-colors"
      >
        Manage Connections
      </a>
    </nav>
    <div className="ml-auto flex items-center gap-2">
      {isSetupComplete && (
        // Top-nav entry point for Helix Connection Settings — a right-side
        // drawer (the form used to be an inline mid-dashboard card, awkward
        // for config that's rarely touched after setup).
        <button
          onClick={onOpenSettings}
          className="p-2 rounded text-[#cfd3da] hover:text-white hover:bg-white/5 transition-colors"
          title="Helix Connection Settings"
          aria-label="Open Helix Connection Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      )}
      <NavAvatar
        authStatus={authStatus}
        onLogout={onLogout}
        currentPage={isSetupComplete ? 'dashboard' : 'onboarding'}
        onJumpToOnboarding={onJumpToOnboarding}
        onOpenSetPassword={onOpenSetPassword}
        onRemovePassword={onRemovePassword}
        onJumpToDashboard={onJumpToDashboard}
        externalApps={externalApps}
      />
    </div>
  </header>
);
