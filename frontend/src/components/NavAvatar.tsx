import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ExternalLink, HelpCircle, LayoutDashboard, LayoutGrid, LogOut, BarChart2, Compass } from 'lucide-react';

type AuthShape = { required: boolean; authenticated: boolean } | null;

// Which configurator-internal page the user is currently on. Drives the
// active-item highlight in the app-switcher dropdown. Pages that don't
// render this component (e.g. /aiops, /step-zero) pass null.
export type CurrentPage = 'onboarding' | 'dashboard' | 'otel-data' | null;

interface NavAvatarProps {
  authStatus: AuthShape;
  onLogout: () => void;
  // Current page for active-state highlighting in the dropdown.
  currentPage?: CurrentPage;
  // Callback so the App page can intercept "Onboarding" navigation from
  // the dropdown — gates behind a confirm dialog when the user is mid-
  // dashboard so they don't lose an active diagnostic.
  onJumpToOnboarding?: () => void;
  // Optional callback so the App page can intercept "Gateway Dashboard"
  // navigation when the user is already mid-onboarding.
  onJumpToDashboard?: () => void;
  // Opens the SetPasswordModal (mounted at the App root) for setting or
  // changing the UI auth password. The dropdown closes first.
  onOpenSetPassword?: () => void;
  // Triggered when the user wants to remove the existing password and
  // reopen the UI to all visitors. The parent handles the confirmation
  // dialog + API call + restart UX.
  onRemovePassword?: () => void;
  // Optional external Helix app links. When provided, they render in a
  // second section of the app-switcher dropdown below the configurator's
  // own pages. Each is gated on the URL being set so users in a partially-
  // configured state don't see broken shortcuts.
  externalApps?: {
    otelDashboardUrl?: string | null;
    aiopsServiceUrl?: string | null;
    applicationUrl?: string | null;
  };
}

// The three header icons on the right of the nav (app switcher, help, avatar)
// mirror the BMC Service Monitoring shell. Avatar opens a dropdown that
// surfaces UI auth status + sign-out — the only place this app exposes auth
// chrome now that the standalone Logout link is gone.
export const NavAvatar: React.FC<NavAvatarProps> = ({ authStatus, onLogout, currentPage, onJumpToOnboarding, onJumpToDashboard, onOpenSetPassword, onRemovePassword, externalApps }) => {
  const ext = externalApps || {};
  const hasExternalLinks = !!(ext.otelDashboardUrl || ext.aiopsServiceUrl || ext.applicationUrl);

  // Active-state styling for the page the user is currently on. Layered
  // on top of the base item classes via concat so it overrides hover/text
  // colors. Border-left accent picks up the brand primary; bg-primary/10
  // adds a subtle tinted backdrop without being garish.
  const itemBase = 'flex items-center gap-2 px-3 py-2 text-sm transition-colors';
  const itemIdle = 'text-gray-200 hover:bg-gray-900 hover:text-white';
  const itemActive = 'bg-primary/15 text-white font-semibold border-l-2 border-primary -ml-px pl-[10px]';
  const cx = (active: boolean) => `${itemBase} ${active ? itemActive : itemIdle}`;
  const [openMenu, setOpenMenu] = useState<null | 'apps' | 'user'>(null);
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
            <button
              type="button"
              onClick={() => {
                if (onJumpToOnboarding) onJumpToOnboarding();
                setOpenMenu(null);
              }}
              className={cx(currentPage === 'onboarding') + ' w-full text-left'}
            >
              <Compass className={`w-4 h-4 ${currentPage === 'onboarding' ? 'text-primary' : 'text-gray-400'}`} />
              Onboarding
            </button>
            <a
              href="/"
              onClick={(e) => {
                if (onJumpToDashboard) {
                  e.preventDefault();
                  onJumpToDashboard();
                  setOpenMenu(null);
                }
              }}
              className={cx(currentPage === 'dashboard')}
            >
              <LayoutDashboard className={`w-4 h-4 ${currentPage === 'dashboard' ? 'text-primary' : 'text-gray-400'}`} />
              Gateway Dashboard
            </a>
            <a
              href="/otel-data"
              className={cx(currentPage === 'otel-data')}
            >
              <BarChart2 className={`w-4 h-4 ${currentPage === 'otel-data' ? 'text-primary' : 'text-gray-400'}`} />
              View OTel Data
            </a>

            {hasExternalLinks && (
              <>
                <div className="border-t border-gray-800 mt-1 pt-1">
                  <div className="px-3 py-2 text-tiny font-semibold text-gray-500 uppercase tracking-wider">Open in Helix</div>
                </div>
                {ext.otelDashboardUrl && (
                  <a
                    href={ext.otelDashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpenMenu(null)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-4 h-4 text-gray-400" />
                    OTel dashboard
                  </a>
                )}
                {ext.aiopsServiceUrl && (
                  <a
                    href={ext.aiopsServiceUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpenMenu(null)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-4 h-4 text-gray-400" />
                    AIOps Business Service
                  </a>
                )}
                {ext.applicationUrl && (
                  <a
                    href={ext.applicationUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpenMenu(null)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900 hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-4 h-4 text-gray-400" />
                    Application UI
                  </a>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Help — direct link to Helix Ops docs in a new tab. Previously this
          was a dropdown with self-description text; routing to the actual
          docs site is more useful (and removes a popup we'd have to keep
          in sync with the product). */}
      <a
        href="https://docs.helixops.ai/bin/IT-Operations-Management/"
        target="_blank"
        rel="noreferrer"
        aria-label="Help (Helix Ops docs)"
        title="Open Helix Ops documentation"
        className={iconBtn}
      >
        <HelpCircle className="w-[18px] h-[18px]" />
      </a>

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
              <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-2">UI access</div>
              {authRequired ? (
                <div className="space-y-2">
                  <div className="text-success inline-flex items-center gap-1.5 text-sm">
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    Password required to sign in
                  </div>
                  <div className="flex items-center gap-3 text-tiny">
                    <button
                      type="button"
                      onClick={() => { setOpenMenu(null); onOpenSetPassword?.(); }}
                      disabled={!onOpenSetPassword}
                      className="text-primary hover:underline disabled:opacity-50 disabled:hover:no-underline disabled:cursor-not-allowed"
                    >
                      Change password
                    </button>
                    <span className="text-gray-700">·</span>
                    <button
                      type="button"
                      onClick={() => { setOpenMenu(null); onRemovePassword?.(); }}
                      disabled={!onRemovePassword}
                      className="text-danger hover:underline disabled:opacity-50 disabled:hover:no-underline disabled:cursor-not-allowed"
                    >
                      Remove password
                    </button>
                  </div>
                </div>
              ) : (
                // No password set. Often deliberate (demos / dev) — frame
                // it as a state, not a TODO. Set-password button lets the
                // user lock it down in-product. The dropdown closes and
                // SetPasswordModal handles the password capture +
                // configurator self-restart.
                <div className="space-y-2">
                  <div className="text-warning inline-flex items-center gap-1.5 text-sm">
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                    No password required
                  </div>
                  <div className="text-tiny text-gray-400 leading-relaxed">
                    Anyone with network access to this URL can use the UI.
                  </div>
                  <button
                    type="button"
                    onClick={() => { setOpenMenu(null); onOpenSetPassword?.(); }}
                    disabled={!onOpenSetPassword}
                    className="text-tiny text-primary hover:underline disabled:opacity-50 disabled:hover:no-underline disabled:cursor-not-allowed"
                  >
                    Set a password →
                  </button>
                </div>
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
