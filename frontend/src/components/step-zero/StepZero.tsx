import React, { useState, useEffect } from 'react';
import { ArrowRight, Boxes, ExternalLink } from 'lucide-react';
import { Layer2Synthetic } from './Layer2Synthetic';
import { Layer3Instrument } from './Layer3Instrument';
import { NavAvatar } from '../NavAvatar';
import { buildHelixBusinessServiceUrl, hasRealHelixEndpoint } from '../otel-data/utils';

const HeaderUserMenu: React.FC = () => {
  const [authStatus, setAuthStatus] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const [externalApps, setExternalApps] = useState<{ otelDashboardUrl: string | null; aiopsServiceUrl: string | null; applicationUrl: string | null } | undefined>(undefined);
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => setAuthStatus({ required: !!d.required, authenticated: !!d.authenticated }))
      .catch(() => setAuthStatus({ required: false, authenticated: true }));
  }, []);
  useEffect(() => {
    fetch('/api/env')
      .then(r => r.ok ? r.json() : null)
      .then(env => {
        if (!env) return;
        const tenantId = (env.HELIX_API_KEY || '').split('::')[0] || '';
        const helixEnv = {
          endpoint: env.HELIX_ENDPOINT || '',
          tenantId,
          source: env.X_SOURCE || '',
          businessServiceKey: env.BUSINESS_SERVICE_KEY || '',
        };
        const base = (env.HELIX_ENDPOINT || '').replace(/\/+$/, '');
        const src = env.X_SOURCE || '';
        setExternalApps({
          otelDashboardUrl: hasRealHelixEndpoint(helixEnv) && tenantId
            ? `${base}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?orgId=${tenantId}&var-BusinessService=${src}&var-OTelNamespace=${src}&from=now-3h&to=now&timezone=browser`
            : null,
          aiopsServiceUrl: buildHelixBusinessServiceUrl(helixEnv),
          applicationUrl: env.APP_URL || null,
        });
      })
      .catch(() => { /* env unset — links stay greyed */ });
  }, []);
  return (
    <NavAvatar
      authStatus={authStatus}
      externalApps={externalApps}
      onLogout={async () => {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.location.href = '/';
      }}
    />
  );
};

export const StepZero: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100 flex flex-col">
      {/* Standard Header Nav */}
      <header className="bg-helixNav flex items-center px-5 h-14 font-helix w-full flex-shrink-0 sticky top-0 z-40 border-b border-[#3a3f4a]">
        <div className="flex items-center gap-4">
          <a href="/" className="flex items-center" aria-label="Helix OTel Configurator home">
            <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
          </a>
          <h1 className="text-white font-normal text-[1.1875rem] m-0 tracking-normal">
            Helix OTel Configurator
          </h1>
        </div>
        <nav className="flex items-center gap-7 text-sm text-[#cfd3da] ml-10">
          <a href="/?view=onboarding" className="hover:text-white transition-colors">
            Onboarding
          </a>
          <a href="/" className="hover:text-white transition-colors">
            Gateway Dashboard
          </a>
          <a href="/otel-data" className="hover:text-white transition-colors">
            View OTel Data
          </a>
          <span className="text-white font-semibold border-b-2 border-primary pb-0.5">
            Start from zero
          </span>
        </nav>
        <div className="ml-auto">
          <HeaderUserMenu />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl w-full mx-auto p-6 space-y-5 flex-1 overflow-y-auto">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Start from zero</h1>
          <p className="text-base text-gray-400 leading-relaxed">
            Three ways to see Helix without instrumenting your own apps first: a 60-second
            synthetic scenario, the upstream OpenTelemetry demo, or guides for instrumenting
            your own.
          </p>
        </header>

        <Layer2Synthetic />

        <Layer3Instrument />

        {/* Pointer to the upstream OTel Demo. Static content; no backend wiring. */}
        <section className="rounded-lg border border-gray-800 bg-gray-1000 p-5 md:p-6">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded bg-gray-900 border border-gray-800 flex items-center justify-center">
              <Boxes className="w-5 h-5 text-blue-300" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-tiny uppercase tracking-wider text-blue-300 mb-1">Real apps, real SDKs</div>
              <h2 className="text-h3 font-semibold text-gray-100 mb-2">Try the OpenTelemetry demo against Helix</h2>
              <p className="text-base text-gray-300 mb-3 leading-relaxed">
                A polyglot demo app (~15 services across Java, .NET, Python, Node, Go, Rust)
                wired with real SDKs. Run it locally, then point its collector at{' '}
                <code className="font-mono text-sm bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-gray-200">
                  http://helix-gateway:4318
                </code>.
              </p>
              <a
                href="https://opentelemetry.io/docs/demo/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-base text-link hover:underline"
              >
                Set up the OpenTelemetry demo <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </section>

        <footer className="pt-3 border-t border-gray-800">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100"
          >
            Continue to the full wizard <ArrowRight className="w-4 h-4" />
          </a>
        </footer>
      </main>
    </div>
  );
};
