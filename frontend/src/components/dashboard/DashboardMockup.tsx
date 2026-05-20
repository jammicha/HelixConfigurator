// MOCKUP — Not wired to real data. Lives at /dashboard-mockup for design review.
// All data here is hardcoded. Delete this file (and the route in main.tsx) once
// the real dashboard refactor lands or the design is rejected.

import React, { useState } from 'react';
import {
  Activity, AlertTriangle, Server, CheckCircle2, ExternalLink,
  Play, RefreshCw, ClipboardList, Stethoscope, Boxes, Settings,
  ChevronDown, Pause, RotateCw, Eye,
} from 'lucide-react';

type PipelineStatus = 'receiving' | 'degraded' | 'broken';

// Static mock data — change these to preview different states.
const MOCK = {
  pipeline: 'receiving' as PipelineStatus,
  pipelineDetail: 'Last span 12s ago. Helix has acknowledged 1,247 spans in the last hour.',
  gateway: { status: 'running' as const, exitCode: undefined as number | undefined },
  throughput: { spansPerSec: 4.2 },
  lastError: { tag: 'bridge.reconnect', message: "network 'helix-bridge' connect to helix-gateway: already exists", ts: Date.now() - 3 * 60 * 60 * 1000 },
  recentServices: [
    { name: 'cart-api', spans: 412, lastSeenSec: 4 },
    { name: 'checkout-web', spans: 287, lastSeenSec: 6 },
    { name: 'payment-service', spans: 198, lastSeenSec: 11 },
    { name: 'inventory-db', spans: 1_204, lastSeenSec: 9 },
    { name: 'notification-svc', spans: 89, lastSeenSec: 47 },
  ],
};

const fmtAgo = (ts: number): string => {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
};

const fmtSecondsAgo = (s: number): string => {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const PipelineBanner: React.FC<{ status: PipelineStatus; detail: string }> = ({ status, detail }) => {
  const config = {
    receiving: {
      bg: 'bg-success/10 border-success/40',
      icon: <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />,
      headline: 'Telemetry is flowing into Helix.',
    },
    degraded: {
      bg: 'bg-warning/10 border-warning/40',
      icon: <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0" />,
      headline: 'Pipeline degraded.',
    },
    broken: {
      bg: 'bg-danger/10 border-danger/40',
      icon: <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0" />,
      headline: 'Telemetry is not reaching Helix.',
    },
  }[status];
  return (
    <div className={`rounded-lg border p-4 flex items-start gap-3 ${config.bg}`}>
      {config.icon}
      <div className="flex-1 min-w-0">
        <div className="text-lg font-semibold text-gray-100">{config.headline}</div>
        <div className="text-base text-gray-300 mt-0.5">{detail}</div>
      </div>
    </div>
  );
};

const SystemHealth: React.FC = () => (
  <div className="adapt-card">
    <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">System health</div>
    <div className="grid grid-cols-3 gap-3">
      {/* Gateway cell — now with inline actions (replaces the standalone Gateway Status card) */}
      <div className="bg-gray-1000 border border-gray-800 rounded p-3">
        <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <Server className="w-3 h-3" /> Gateway
        </div>
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold text-success">{MOCK.gateway.status}</div>
          <div className="flex items-center gap-1">
            <button className="p-1 text-gray-500 hover:text-gray-200" title="Start"><Play className="w-3.5 h-3.5" /></button>
            <button className="p-1 text-gray-500 hover:text-gray-200" title="Stop"><Pause className="w-3.5 h-3.5" /></button>
            <button className="p-1 text-gray-500 hover:text-gray-200" title="Restart"><RotateCw className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      </div>
      <div className="bg-gray-1000 border border-gray-800 rounded p-3">
        <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <Activity className="w-3 h-3" /> Throughput (1h)
        </div>
        <div className="text-base font-semibold text-gray-200 tabular-nums">{MOCK.throughput.spansPerSec.toFixed(1)} spans/s</div>
      </div>
      <div className="bg-gray-1000 border border-gray-800 rounded p-3">
        <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" /> Last error
        </div>
        <div className="text-base font-semibold text-warning truncate" title={MOCK.lastError.message}>{MOCK.lastError.tag}</div>
        <div className="text-tiny text-gray-500">{fmtAgo(MOCK.lastError.ts)}</div>
      </div>
    </div>
  </div>
);

const QuickActions: React.FC = () => (
  <div className="adapt-card">
    <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">Quick actions</div>
    <div className="grid grid-cols-4 gap-3">
      <button className="bg-gray-1000 hover:bg-gray-900 border border-gray-800 text-gray-200 py-2.5 px-3 rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <RefreshCw className="w-4 h-4" /> Re-verify telemetry
      </button>
      <button className="bg-gray-1000 hover:bg-gray-900 border border-gray-800 text-gray-200 py-2.5 px-3 rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <Stethoscope className="w-4 h-4" /> Run diagnostic
      </button>
      <button className="bg-gray-1000 hover:bg-gray-900 border border-gray-800 text-gray-200 py-2.5 px-3 rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <ClipboardList className="w-4 h-4" /> Copy support bundle
      </button>
      <button className="bg-gray-1000 hover:bg-gray-900 border border-gray-800 text-gray-200 py-2.5 px-3 rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors">
        <Boxes className="w-4 h-4" /> Discovered services
      </button>
    </div>
  </div>
);

const RecentServices: React.FC = () => (
  <div className="adapt-card">
    <div className="flex items-center justify-between mb-3">
      <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Recent services</div>
      <a href="/otel-data" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
        <Eye className="w-4 h-4" /> View OTel data
      </a>
    </div>
    <div className="space-y-1">
      {MOCK.recentServices.map(s => (
        <div key={s.name} className="flex items-center justify-between px-3 py-2 rounded hover:bg-gray-1000 group">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-2 h-2 rounded-full bg-success flex-shrink-0" aria-hidden="true" />
            <span className="font-mono text-base text-gray-200 truncate">{s.name}</span>
          </div>
          <div className="flex items-center gap-4 text-tiny text-gray-500 flex-shrink-0">
            <span className="tabular-nums">{s.spans.toLocaleString()} spans</span>
            <span className="w-16 text-right tabular-nums">{fmtSecondsAgo(s.lastSeenSec)}</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const LogsPanelStub: React.FC = () => (
  <div className="adapt-card">
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-base font-semibold text-gray-200">Logs</h2>
      <div className="flex items-center gap-1 text-tiny">
        <button className="px-2 py-1 rounded bg-gray-800 text-gray-100 uppercase tracking-wider">helix-gateway</button>
        <button className="px-2 py-1 rounded text-gray-500 hover:text-gray-300 uppercase tracking-wider">connected app</button>
      </div>
    </div>
    <pre className="bg-gray-1000 border border-gray-800 rounded p-3 text-sm font-mono text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-64">
{`2026-05-20T14:31:08.182Z info  ResourceSpans #0 received 12 spans
2026-05-20T14:31:08.291Z info  Exporting to https://otel-itom.onbmc.com (status 200)
2026-05-20T14:31:11.044Z info  ResourceSpans #0 received 8 spans
2026-05-20T14:31:11.103Z info  Exporting to https://otel-itom.onbmc.com (status 200)
2026-05-20T14:31:14.521Z info  ResourceSpans #0 received 6 spans
2026-05-20T14:31:14.601Z info  Exporting to https://otel-itom.onbmc.com (status 200)`}
    </pre>
  </div>
);

const Collapsible: React.FC<{ title: string; icon: React.ReactNode }> = ({ title, icon }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="adapt-card">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 w-full text-left group">
        {icon}
        <h2 className="text-base font-semibold text-gray-200 flex-1">{title}</h2>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-4 text-sm text-gray-500">
          (Collapsible content — actual editors / forms live here in the real component.)
        </div>
      )}
    </div>
  );
};

const OpenInHelix: React.FC = () => (
  <div className="flex items-center gap-2 flex-wrap text-sm">
    <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Open in Helix:</span>
    <a href="#" className="inline-flex items-center gap-1.5 text-primary hover:underline">OTel dashboard <ExternalLink className="w-3.5 h-3.5" /></a>
    <span className="text-gray-700">·</span>
    <a href="#" className="inline-flex items-center gap-1.5 text-primary hover:underline">AIOps service <ExternalLink className="w-3.5 h-3.5" /></a>
    <span className="text-gray-700">·</span>
    <a href="#" className="inline-flex items-center gap-1.5 text-primary hover:underline">Application UI <ExternalLink className="w-3.5 h-3.5" /></a>
  </div>
);

export const DashboardMockup: React.FC = () => {
  const [pipeline, setPipeline] = useState<PipelineStatus>(MOCK.pipeline);
  const pipelineDetail = {
    receiving: 'Last span 12s ago. Helix has acknowledged 1,247 spans in the last hour.',
    degraded: 'Spans are reaching the gateway but Helix has not acknowledged any in the last 5 minutes. Check your API key.',
    broken: 'helix-gateway is not running. Restart it from the gateway controls below.',
  }[pipeline];

  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100">
      <main className="max-w-5xl mx-auto p-6 space-y-5">
        {/* Mockup banner */}
        <div className="rounded border border-blue-900 bg-blue-950/30 px-4 py-2 text-sm text-blue-200 flex items-center gap-3">
          <span className="font-semibold">MOCKUP</span>
          <span>Not wired to live data. Toggle pipeline state:</span>
          <div className="flex items-center gap-1 ml-auto">
            {(['receiving', 'degraded', 'broken'] as PipelineStatus[]).map(s => (
              <button
                key={s}
                onClick={() => setPipeline(s)}
                className={`px-2.5 py-1 text-tiny rounded uppercase tracking-wider ${pipeline === s ? 'bg-primary text-white' : 'text-blue-200 hover:bg-blue-900/40'}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <header>
          <h1 className="text-h2 font-semibold mb-1">Helix Configurator</h1>
          <p className="text-base text-gray-400">Operational dashboard for the gateway and your telemetry pipeline.</p>
        </header>

        {/* TOP — always-visible status */}
        <PipelineBanner status={pipeline} detail={pipelineDetail} />
        <SystemHealth />

        {/* MIDDLE — common-use */}
        <QuickActions />
        <RecentServices />
        <LogsPanelStub />

        {/* BOTTOM — power-use collapsibles */}
        <Collapsible title="Helix Connection Settings" icon={<Settings className="w-4 h-4 text-gray-500" />} />
        <Collapsible title="Gateway Config (YAML)" icon={<Settings className="w-4 h-4 text-gray-500" />} />

        <OpenInHelix />
      </main>
    </div>
  );
};
