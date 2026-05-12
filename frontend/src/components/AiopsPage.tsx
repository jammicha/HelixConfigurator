import React, { useState } from 'react';
import {
  AlertTriangle,
  Apple,
  Check,
  Cloud,
  Copy,
  Download,
  HelpCircle,
  Loader2,
  Grid3x3,
  Server,
  SquareStack,
  Terminal,
} from 'lucide-react';

type Step = 1 | 2;
type HostingProvider = 'my-host' | 'azure' | 'aws';
type Platform = 'mac' | 'linux' | 'windows';

const SIDEBAR_ITEMS = [
  'General Settings',
  'Manage Product Features',
  'Manage Situations',
  'Manage Notifications',
  'Manage Service Blueprints',
  'Manage Service Health',
  'Manage Opentelemetry',
];

const TOP_TABS = ['Overview', 'Services', 'Situations', 'Predictions', 'Dashboards', 'Configurations'];

type Configured = {
  token: string;
  apiKey: string;
  xSource: string;
  installBaseUrl: string;
};

const detectPlatform = (): Platform => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'windows';
  return 'linux';
};

// Simple Tux silhouette — Lucide doesn't ship a Linux/Tux icon.
const LinuxIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M12 2c-2.2 0-3.5 1.7-3.5 4 0 1 .2 1.9.6 2.7-.9.7-1.6 1.7-2 2.8-.6 1.5-1 3-1.6 4.4-.4.9-.9 1.7-1.5 2.4-.4.5-.5 1-.2 1.4.3.4.9.4 1.5.1.4-.2.8-.4 1.1-.7.1.6.4 1.2.8 1.6.7.7 1.7 1.1 2.7 1.2.4 0 .8 0 1.2-.1.4.1.8.1 1.2.1 1-.1 2-.5 2.7-1.2.4-.4.7-1 .8-1.6.3.3.7.5 1.1.7.6.3 1.2.3 1.5-.1.3-.4.2-.9-.2-1.4-.6-.7-1.1-1.5-1.5-2.4-.6-1.4-1-2.9-1.6-4.4-.4-1.1-1.1-2.1-2-2.8.4-.8.6-1.7.6-2.7 0-2.3-1.3-4-3.5-4Zm-1.5 4.5c.3 0 .5.4.5.8s-.2.7-.5.7-.5-.3-.5-.7.2-.8.5-.8Zm3 0c.3 0 .5.4.5.8s-.2.7-.5.7-.5-.3-.5-.7.2-.8.5-.8Zm-1.5 2.5c.6 0 1.2.3 1.5.7-.3.4-.9.7-1.5.7s-1.2-.3-1.5-.7c.3-.4.9-.7 1.5-.7Z" />
  </svg>
);

// Simple 4-pane Windows logo.
const WindowsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M3 5.5 11 4.4v7.1H3V5.5Zm0 7H11v7.1L3 18.5v-6Zm9-8.2L21.5 3v9H12V4.3Zm0 8.7H21.5v9L12 20.7V13Z" />
  </svg>
);

const PLATFORM_LABEL: Record<Platform, string> = {
  mac: 'Mac',
  linux: 'Linux',
  windows: 'Windows',
};

export const AiopsPage: React.FC = () => {
  const [xSource, setXSource] = useState('');
  const [step, setStep] = useState<Step>(1);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState<Configured | null>(null);
  const [hostingProvider, setHostingProvider] = useState<HostingProvider>('my-host');
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // installBaseUrl comes from the backend — it substitutes the LAN IP for
  // localhost so the command works when pasted on a different machine.
  const installCmd = configured
    ? platform === 'windows'
      ? `iwr -useb ${configured.installBaseUrl}/api/_demo/aiops/install/${configured.token}.ps1 | iex`
      : `curl -sSL ${configured.installBaseUrl}/api/_demo/aiops/install/${configured.token}.sh | bash`
    : '';

  const canConfigure = xSource.trim().length > 0 && !generating;

  const handleConfigure = async () => {
    if (!canConfigure) return;
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/_demo/aiops/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xSource: xSource.trim() }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as Configured;
      setConfigured(data);
      setStep(2);
    } catch (e: any) {
      setError(e?.message || 'Failed to generate package');
    } finally {
      setGenerating(false);
    }
  };

  const downloadZip = () => {
    if (!configured) return;
    window.location.href = `/api/_demo/aiops/package/${configured.token}`;
  };

  const copy = async (id: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey((k) => (k === id ? null : k)), 1500);
    } catch {
      // ignore
    }
  };

  const stepDot = (n: Step) => {
    const isActive = step === n;
    const isDone = step > n;
    return (
      <div className="flex flex-col items-center" style={{ width: 28 }}>
        <div
          className={
            'w-5 h-5 rounded-full border-2 flex items-center justify-center ' +
            (isDone
              ? 'bg-orange-500 border-orange-500'
              : isActive
              ? 'border-orange-500 bg-white'
              : 'border-gray-300 bg-white')
          }
        >
          {isDone ? (
            <Check className="w-3 h-3 text-white" strokeWidth={3} />
          ) : isActive ? (
            <div className="w-2 h-2 rounded-full bg-orange-500" />
          ) : null}
        </div>
      </div>
    );
  };

  type TileProps = {
    selected: boolean;
    disabled?: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    iconClass?: string;
    label: string;
    badge?: string;
  };
  const Tile: React.FC<TileProps> = ({ selected, disabled, onClick, icon, iconClass, label, badge }) => (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={
        'relative flex items-center gap-4 px-5 py-3.5 rounded transition-colors min-w-[180px] ' +
        (disabled
          ? 'border-2 border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
          : selected
          ? 'border-2 border-orange-500 bg-white text-gray-900 shadow-sm'
          : 'border border-gray-300 bg-white text-gray-700 hover:border-gray-400')
      }
    >
      <span className={'flex items-center justify-center w-7 h-7 ' + (iconClass || '')}>{icon}</span>
      <span className="text-[14px] font-medium">{label}</span>
      {badge ? (
        <span className="absolute top-1 right-1 text-[9px] uppercase tracking-wide bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
          {badge}
        </span>
      ) : null}
    </button>
  );

  const codeBlock = (id: string, text: string) => (
    <div className="flex items-stretch border border-gray-300 rounded overflow-hidden bg-gray-900">
      <code className="flex-1 px-3 py-2 text-[12px] font-mono text-gray-100 break-all select-all">{text}</code>
      <button
        onClick={() => copy(id, text)}
        className="px-3 border-l border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-100 text-[12px] flex items-center gap-1"
      >
        {copiedKey === id ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        {copiedKey === id ? 'Copied' : 'Copy'}
      </button>
    </div>
  );

  const platformLabel = PLATFORM_LABEL[platform];
  const terminalApp =
    platform === 'mac' ? 'Terminal' : platform === 'windows' ? 'PowerShell' : 'a terminal';

  return (
    <div className="min-h-screen bg-white text-gray-900" style={{ fontFamily: '"Inter", "Segoe UI", system-ui, sans-serif' }}>
      <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-[12px] px-4 py-1.5 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>
          <strong>Simulated AIOps page.</strong> This is a mock of the BMC Helix "Manage Opentelemetry" wizard. The
          API key generated below is fake and will not authenticate against a real Helix tenant.
        </span>
      </div>

      <header className="border-b border-gray-200 bg-white">
        <div className="flex items-center px-4 h-12">
          <div className="flex items-center gap-2 mr-8">
            <img src="/bmc-logo.svg" alt="BMC" className="h-5 w-auto" />
            <span className="text-[15px] text-gray-800">Service Monitoring</span>
          </div>
          <nav className="flex items-center gap-6 text-[13px] text-gray-700">
            {TOP_TABS.map((t) => (
              <a
                key={t}
                href="#"
                className={
                  'py-3 border-b-2 ' +
                  (t === 'Configurations'
                    ? 'border-orange-500 text-gray-900 font-medium'
                    : 'border-transparent hover:text-gray-900')
                }
                onClick={(e) => e.preventDefault()}
              >
                {t}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-gray-500">
            <Grid3x3 className="w-4 h-4" />
            <HelpCircle className="w-4 h-4" />
            <div className="w-7 h-7 rounded-full bg-gray-700 text-white text-xs flex items-center justify-center">A</div>
          </div>
        </div>
      </header>

      <div className="flex" style={{ minHeight: 'calc(100vh - 80px)' }}>
        <aside className="w-60 border-r border-gray-200 bg-gray-50">
          <ul className="text-[13px] text-gray-700">
            {SIDEBAR_ITEMS.map((item) => {
              const active = item === 'Manage Opentelemetry';
              return (
                <li
                  key={item}
                  className={
                    'px-4 py-2 cursor-default ' +
                    (active ? 'bg-white text-gray-900 font-medium border-l-2 border-orange-500' : 'hover:bg-gray-100')
                  }
                >
                  {item}
                </li>
              );
            })}
          </ul>
        </aside>

        <main className="flex-1 px-10 py-6">
          <div className="border-b border-gray-200 mb-8">
            <span className="inline-block py-2 px-1 border-b-2 border-orange-500 font-medium text-gray-900 text-[14px]">
              Manage Opentelemetry
            </span>
          </div>

          <div className="max-w-4xl">
            {/* Step 1 — Name */}
            <div className="flex gap-4">
              {stepDot(1)}
              <div className="flex-1 pb-8 border-l border-dashed border-gray-300 -ml-3 pl-7 -mt-1">
                <div className="text-[12px] text-gray-500">Step 1 of 2</div>
                <div className="text-[15px] font-medium text-gray-900 mt-0.5">Name your application</div>
                <div className="text-[13px] text-gray-500 mt-0.5">
                  This will be the name of the X-Source your collector reports under.
                </div>

                <div className="mt-5 max-w-xl">
                  <label className="text-[12px] text-gray-700">
                    Name <span className="text-red-500">(required)</span>
                  </label>
                  <input
                    type="text"
                    value={xSource}
                    onChange={(e) => setXSource(e.target.value)}
                    placeholder="Type a name"
                    className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-[13px] focus:outline-none focus:border-orange-500"
                  />

                  <div className="flex items-center gap-3 pt-4">
                    <button
                      onClick={handleConfigure}
                      disabled={!canConfigure}
                      className={
                        'inline-flex items-center gap-2 px-4 py-2 rounded text-[13px] font-medium text-white ' +
                        (canConfigure ? 'bg-orange-500 hover:bg-orange-600' : 'bg-orange-300 cursor-not-allowed')
                      }
                    >
                      {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      {generating ? 'Configuring...' : 'Configure'}
                    </button>
                    {error ? <span className="text-[12px] text-red-600">{error}</span> : null}
                  </div>
                </div>
              </div>
            </div>

            {/* Step 2 — Install */}
            <div className="flex gap-4">
              {stepDot(2)}
              <div className="flex-1 pb-8 -ml-3 pl-7 -mt-1">
                <div className="text-[12px] text-gray-500">Step 2 of 2</div>
                <div className="text-[15px] font-medium text-gray-900 mt-0.5">Install the configurator sidecar</div>
                <div className="text-[13px] text-gray-500 mt-0.5">
                  Pick where you'll run the sidecar, then run the install command for your platform.
                </div>

                {configured ? (
                  <div className="mt-6 space-y-7">
                    {/* API key */}
                    <div className="max-w-2xl">
                      <div className="flex items-center gap-2 text-[12px] text-gray-700 mb-1">
                        <span>Generated API key</span>
                        <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide">
                          <AlertTriangle className="w-3 h-3" />
                          Simulated
                        </span>
                      </div>
                      <div className="flex items-stretch border border-gray-300 rounded overflow-hidden bg-gray-50">
                        <code className="flex-1 px-3 py-2 text-[12px] font-mono text-gray-800 break-all select-all">
                          {configured.apiKey}
                        </code>
                        <button
                          onClick={() => copy('apikey', configured.apiKey)}
                          className="px-3 border-l border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-[12px] flex items-center gap-1"
                        >
                          {copiedKey === 'apikey' ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedKey === 'apikey' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        Same key is embedded in the install command and downloaded zip below.
                      </div>
                    </div>

                    {/* Pickers */}
                    <div className="grid grid-cols-[140px_1fr] gap-x-6 gap-y-4 items-center">
                      <div className="text-[14px] text-gray-700">Hosting Provider</div>
                      <div className="flex flex-wrap gap-3">
                        <Tile
                          selected={hostingProvider === 'my-host'}
                          onClick={() => setHostingProvider('my-host')}
                          icon={<Server className="w-5 h-5" />}
                          iconClass="text-blue-600"
                          label="My Host"
                        />
                        <Tile
                          selected={hostingProvider === 'azure'}
                          disabled
                          onClick={() => setHostingProvider('azure')}
                          icon={<Cloud className="w-5 h-5" />}
                          iconClass="text-blue-500"
                          label="Azure"
                          badge="Soon"
                        />
                        <Tile
                          selected={hostingProvider === 'aws'}
                          disabled
                          onClick={() => setHostingProvider('aws')}
                          icon={<SquareStack className="w-5 h-5" />}
                          iconClass="text-orange-500"
                          label="AWS"
                          badge="Soon"
                        />
                      </div>

                      <div className="text-[14px] text-gray-700">Platform</div>
                      <div className="flex flex-wrap gap-3">
                        <Tile
                          selected={platform === 'mac'}
                          onClick={() => setPlatform('mac')}
                          icon={<Apple className="w-5 h-5" />}
                          iconClass="text-gray-700"
                          label="Mac"
                        />
                        <Tile
                          selected={platform === 'linux'}
                          onClick={() => setPlatform('linux')}
                          icon={<LinuxIcon className="w-6 h-6" />}
                          iconClass="text-gray-700"
                          label="Linux"
                        />
                        <Tile
                          selected={platform === 'windows'}
                          onClick={() => setPlatform('windows')}
                          icon={<WindowsIcon className="w-5 h-5" />}
                          iconClass="text-blue-600"
                          label="Windows"
                        />
                      </div>
                    </div>

                    {/* Directions */}
                    <div className="border-t border-gray-200 pt-5">
                      <div className="flex items-center gap-2 text-orange-600 text-[14px] font-medium mb-2">
                        <Terminal className="w-4 h-4" />
                        {platformLabel} Installer Directions
                      </div>
                      <ol className="text-[13px] text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
                        <li>Open {terminalApp} on the host where your application runs.</li>
                        <li>Make sure Docker Desktop / Docker Engine is installed and running.</li>
                        <li>Paste and run the command below — it downloads, builds, and starts the sidecar:</li>
                      </ol>
                      <div className="max-w-3xl">{codeBlock('install', installCmd)}</div>
                      <div className="text-[11px] text-gray-500 mt-1.5">
                        {platform === 'windows'
                          ? 'No download dialog or SmartScreen prompts — the script is piped straight into PowerShell.'
                          : 'No download dialog or Gatekeeper prompts — the script is piped straight into bash.'}
                      </div>
                    </div>

                    {/* Manual fallback */}
                    <div className="border-t border-gray-200 pt-5">
                      <div className="text-[13px] text-gray-700 mb-2">Or install manually:</div>
                      <button
                        onClick={downloadZip}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded text-[13px] text-gray-700 border border-gray-300 hover:bg-gray-50"
                      >
                        <Download className="w-4 h-4" />
                        Download .zip
                      </button>
                      <div className="text-[11px] text-gray-500 mt-1.5">
                        Unzip and run <code className="font-mono">start.command</code> (Mac) /{' '}
                        <code className="font-mono">start.bat</code> (Windows) /{' '}
                        <code className="font-mono">start.sh</code> (Linux). See the README for the Mac
                        Gatekeeper workaround.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 text-[12px] text-gray-400 italic">
                    Available after you click Configure.
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
