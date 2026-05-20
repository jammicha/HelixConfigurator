import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, HelpCircle, LayoutDashboard, LayoutGrid, LogOut, BarChart2 } from 'lucide-react';

type AuthShape = { required: boolean; authenticated: boolean } | null;

interface NavAvatarProps {
  authStatus: AuthShape;
  onLogout: () => void;
  // Optional callback so the App page can intercept "Gateway Dashboard"
  // navigation when the user is already mid-onboarding.
  onJumpToDashboard?: () => void;
}

// The three header icons on the right of the nav (app switcher, help, avatar)
// mirror the BMC Service Monitoring shell. Avatar opens a dropdown that
// surfaces UI auth status + sign-out — the only place this app exposes auth
// chrome now that the standalone Logout link is gone.
export const NavAvatar: React.FC<NavAvatarProps> = ({ authStatus, onLogout, onJumpToDashboard }) => {
  const [openMenu, setOpenMenu] = useState<null | 'apps' | 'help' | 'user'>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const authRequired = !!authStatus?.required;
  const authenticated = !!authStatus?.authenticated;

  const iconBtn = 'flex items-center justify-center w-8 h-8 rounded text-[#cfd3da] hover:text-white hover:bg-white/5 transition-colors';

  return (
    <div ref={wrapRef} className="flex items-center gap-1 relative">
      {/* App switcher (waffle) */}
      <div className="relative">
        <button
          type="button"
          aria-label="Switch Helix apps"
          aria-expanded={openMenu === 'apps'}
          onClick={() => setOpenMenu(openMenu === 'apps' ? null : 'apps')}
          className={iconBtn + ' gap-0.5'}
        >
          <LayoutGrid className="w-[18px] h-[18px]" />
          <ChevronDown className="w-3 h-3 -mr-0.5" />
        </button>
        {openMenu === 'apps' && (
          <div className="absolute right-0 top-full mt-2 w-56 bg-gray-1000 border border-gray-800 rounded shadow-3 py-1 z-50">
            <div className="px-3 py-2 text-tiny font-semibold text-gray-500 uppercase tracking-wider">Helix apps</div>
            <a
              href="/"
              onClick={(e) => {
                if (onJumpToDashboard) {
                  e.preventDefault();
                  onJumpToDashboard();
                  setOpenMenu(null);
                }
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors"
            >
              <LayoutDashboard className="w-4 h-4 text-gray-400" />
              Gateway Dashboard
            </a>
            <a
              href="/otel-data"
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors"
            >
              <BarChart2 className="w-4 h-4 text-gray-400" />
              View OTel Data
            </a>
          </div>
        )}
      </div>

      {/* Help */}
      <div className="relative">
        <button
          type="button"
          aria-label="Help"
          aria-expanded={openMenu === 'help'}
          onClick={() => setOpenMenu(openMenu === 'help' ? null : 'help')}
          className={iconBtn}
        >
          <HelpCircle className="w-[18px] h-[18px]" />
        </button>
        {openMenu === 'help' && (
          <div className="absolute right-0 top-full mt-2 w-72 bg-gray-1000 border border-gray-800 rounded shadow-3 py-3 z-50">
            <div className="px-4 pb-2">
              <div className="text-sm font-semibold text-gray-100">Helix OTel Configurator</div>
              <div className="text-tiny text-gray-500 mt-0.5">Onboarding wizard + OTel gateway for BMC Helix</div>
            </div>
            <div className="border-t border-gray-800 mt-1 pt-2 px-4 text-tiny text-gray-400 leading-relaxed">
              Stuck? Re-run onboarding from the nav at any time, or use the diagnostics panel on the Gateway Dashboard.
            </div>
          </div>
        )}
      </div>

      {/* Avatar */}
      <div className="relative ml-1">
        <button
          type="button"
          aria-label="Account menu"
          aria-expanded={openMenu === 'user'}
          onClick={() => setOpenMenu(openMenu === 'user' ? null : 'user')}
          className="flex items-center gap-0.5 rounded hover:bg-white/5 transition-colors py-1 pr-1 pl-1"
        >
          <span className="w-8 h-8 rounded-full bg-[#4dc5d6] text-[#0e2530] font-semibold text-sm flex items-center justify-center">
            A
          </span>
          <ChevronDown className="w-3 h-3 text-[#cfd3da]" />
        </button>
        {openMenu === 'user' && (
          <div className="absolute right-0 top-full mt-2 w-80 bg-gray-1000 border border-gray-800 rounded shadow-3 py-1 z-50">
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-sm font-semibold text-gray-100">Administrator</div>
              <div className="text-tiny text-gray-500 mt-0.5">Local Helix OTel Configurator</div>
            </div>
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-2">UI Access</div>
              {authRequired ? (
                <span className="text-success inline-flex items-center gap-1.5 text-sm">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Password required
                </span>
              ) : (
                <>
                  <div className="text-warning text-sm">Open (no password)</div>
                  <div className="text-tiny text-gray-500 mt-1.5 leading-relaxed">
                    Set <span className="font-mono text-gray-300">UI_AUTH_PASSWORD</span> in{' '}
                    <span className="font-mono text-gray-300">.env</span> and restart to require sign-in.
                  </div>
                </>
              )}
            </div>
            {authRequired && authenticated && (
              <button
                type="button"
                onClick={() => { setOpenMenu(null); onLogout(); }}
                className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors flex items-center gap-2"
              >
                <LogOut className="w-4 h-4 text-gray-400" />
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
