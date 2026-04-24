import React, { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Settings } from 'lucide-react';

const App = () => {
  const [config, setConfig] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [envVars, setEnvVars] = useState({
    HELIX_ENDPOINT: '',
    HELIX_API_KEY: '',
    X_SOURCE: ''
  });

  useEffect(() => {
    // Fetch YAML config
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setConfig(data.yaml || ''))
      .catch(err => console.error('Failed to fetch config', err));

    // Fetch Env vars
    fetch('/api/env')
      .then(res => res.json())
      .then(data => setEnvVars(data))
      .catch(err => console.error('Failed to fetch env vars', err));
  }, []);

  const handleUpdateSettings = async () => {
    try {
      const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envVars)
      });
      if (res.ok) {
        alert('Settings updated successfully');
      } else {
        alert('Failed to update settings');
      }
    } catch (err) {
      console.error('Update failed', err);
      alert('Error updating settings');
    }
  };

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {/* Header */}
      <header className="bg-gray-1000 border-b border-gray-800 h-14 flex items-center justify-between px-6">
        <div className="flex items-center h-full">
          {/* Logo Area */}
          <div className="flex items-center gap-2 mr-8">
            <div className="text-xl font-bold tracking-wide flex items-center gap-1">
              <span className="text-danger">bmc</span>
              <span className="text-white">helix</span>
            </div>
            <div className="w-px h-6 bg-gray-800"></div>
            <span className="text-gray-300 font-medium">Configurator</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="bg-success/20 text-success border border-success/30 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-success"></span>
            API Connected
          </span>
        </div>
      </header>

      <main className="flex-1 p-6 space-y-6 max-w-7xl mx-auto w-full">
        
        {/* Row 1 */}
        <div className="grid grid-cols-2 gap-6">
          {/* Core Infrastructure */}
          <div className="adapt-card">
            <h2 className="text-lg font-bold mb-4 text-gray-200">Core Infrastructure</h2>
            <div className="flex gap-3">
              <button className="flex-1 bg-success text-white py-2 rounded font-semibold hover:bg-opacity-90 transition-opacity">
                START
              </button>
              <button className="flex-1 bg-danger text-white py-2 rounded font-semibold hover:bg-opacity-90 transition-opacity">
                STOP
              </button>
              <button 
                onClick={async () => {
                  try {
                    const res = await fetch('/api/lifecycle/restart', { method: 'POST' });
                    if (res.ok) alert('Container restarted successfully');
                    else alert('Failed to restart container');
                  } catch (e) {
                    alert('Error restarting container');
                  }
                }}
                className="flex-1 bg-warning text-gray-900 py-2 rounded font-semibold hover:bg-opacity-90 transition-opacity"
              >
                RESTART
              </button>
            </div>
          </div>

          {/* Operation Shortcuts */}
          <div className="adapt-card">
            <h2 className="text-lg font-bold mb-4 text-gray-200">Operation Shortcuts</h2>
            <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={() => setShowDiagnostics(true)}
                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors"
              >
                Run Diagnostic Health Check
              </button>
              <a 
                href={(() => {
                  try {
                    const baseUrl = new URL(envVars.HELIX_ENDPOINT).origin;
                    return `${baseUrl}/dashboards?service=${envVars.X_SOURCE}`;
                  } catch {
                    return '#';
                  }
                })()}
                target="_blank"
                rel="noreferrer"
                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full"
              >
                Helix OTel Dashboard
              </a>
              <button className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors">
                Trace Insights
              </button>
              <a 
                href={(envVars as any).APP_URL || 'http://localhost:8080'}
                target="_blank"
                rel="noreferrer"
                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full"
              >
                Application UI
              </a>
            </div>
          </div>
        </div>

        {/* Helix Connection Settings */}
        <div className="adapt-card">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="w-5 h-5 text-gray-400" />
            <h2 className="text-lg font-bold text-gray-200">Helix Connection Settings</h2>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Helix Endpoint</label>
              <input 
                type="text" 
                value={envVars.HELIX_ENDPOINT}
                onChange={(e) => setEnvVars({...envVars, HELIX_ENDPOINT: e.target.value})}
                className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-primary transition-colors"
                placeholder="https://..."
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">API Key</label>
              <input 
                type="password" 
                value={envVars.HELIX_API_KEY}
                onChange={(e) => setEnvVars({...envVars, HELIX_API_KEY: e.target.value})}
                className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-primary transition-colors"
                placeholder="Enter API Key"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">X-Source (Business Service)</label>
              <input 
                type="text" 
                value={envVars.X_SOURCE}
                onChange={(e) => setEnvVars({...envVars, X_SOURCE: e.target.value})}
                className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-primary transition-colors"
                placeholder="Source Name"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button 
              onClick={handleUpdateSettings}
              className="bg-primary hover:bg-primary/90 text-white px-6 py-2 rounded font-semibold transition-colors"
            >
              Update Settings
            </button>
          </div>
        </div>

        {showDiagnostics && (
          <>
            {/* Row 2 */}
            <div className="adapt-card">
              <h2 className="text-lg font-bold mb-4 text-gray-200">Helix Troubleshooting & Diagnostics</h2>
              <div className="grid grid-cols-4 gap-4">
                {['Collector Configuration', 'X-API Key Format', 'X-Source Format', 'Tenant URL Endpoint'].map((title, i) => {
                  let isPass = false;
                  if (title === 'Collector Configuration') {
                    isPass = !!(
                      config && 
                      config.includes('otlp') && 
                      config.includes('otlphttp/bmchelix') && 
                      !config.includes('transform:')
                    );
                  }
                  if (title === 'X-API Key Format') {
                    isPass = !!(envVars.HELIX_API_KEY && /^[^:]+::[^:]+::[^:]+$/.test(envVars.HELIX_API_KEY));
                  }
                  if (title === 'X-Source Format') {
                    isPass = !!(envVars.X_SOURCE && envVars.X_SOURCE.length > 0);
                  }
                  if (title === 'Tenant URL Endpoint') {
                    isPass = !!(envVars.HELIX_ENDPOINT && /^https?:\/\//.test(envVars.HELIX_ENDPOINT));
                  }

                  return (
                    <div key={i} className="bg-gray-800 border border-gray-700 p-4 rounded flex flex-col items-center justify-center gap-3">
                      <span className="text-sm font-semibold text-gray-300 text-center">{title}</span>
                      {isPass ? (
                        <span className="bg-success/20 text-success border border-success/30 px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
                          PASS
                        </span>
                      ) : (
                        <span className="bg-danger/20 text-danger border border-danger/30 px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
                          FAIL
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Row 3 */}
            <div className="adapt-card flex flex-col">
              <h2 className="text-lg font-bold mb-4 text-gray-200">Collector Troubleshooting Logs</h2>
              <div className="bg-gray-1000 p-4 rounded border border-gray-800 h-48 overflow-y-auto font-mono text-sm text-green-400">
                <p>2026-04-23T10:15:30.001Z info    service/telemetry.go:115    Setting up telemetry...</p>
                <p>2026-04-23T10:15:30.050Z info    service/service.go:133      Starting otelcol...</p>
                <p>2026-04-23T10:15:30.052Z info    service/pipelines.go:121    Starting pipelines...</p>
                <p>2026-04-23T10:15:30.100Z info    receiver/otlpreceiver/otlp.go:102   Starting otlp receiver on :4317</p>
                <p>2026-04-23T10:15:30.105Z info    exporter/otlphttpexporter/otlp.go:145   Starting otlphttp exporter to bmchelix</p>
                <p>2026-04-23T10:15:30.150Z info    service/service.go:150      Everything is ready. Begin running and processing data.</p>
                <p className="animate-pulse">_</p>
              </div>
            </div>
          </>
        )}

        {/* Row 4 */}
        <div className="adapt-card flex flex-col h-[500px]">
          <h2 className="text-lg font-bold mb-4 text-gray-200">Observability Pipeline Config (YAML)</h2>
          <div className="flex-1 border border-gray-800 rounded overflow-hidden">
            <Editor
              height="100%"
              defaultLanguage="yaml"
              theme="vs-dark"
              value={config}
              onChange={(v) => setConfig(v || '')}
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 16 }
              }}
            />
          </div>
        </div>

      </main>
    </div>
  );
};

export default App;
