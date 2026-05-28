import React, { useEffect, useState } from 'react';
import { Copy, Check, ExternalLink, Info } from 'lucide-react';
import type { Language, EndpointMode, SnippetResponse } from './instrument-types';

const SERVICE_NAME_PLACEHOLDER = 'my-app';

const LANG_LABEL: Record<Language, string> = {
  java: 'Java',
  python: 'Python',
  dotnet: '.NET',
  node: 'Node.js',
};

type CopyKind = 'compose' | 'shell' | 'manual-install' | 'manual-init' | 'manual-span';

type Props = {
  language: Language;
};

export const LanguageGuide: React.FC<Props> = ({ language }) => {
  const [endpointMode, setEndpointMode] = useState<EndpointMode>('compose');
  const [snippetTab, setSnippetTab] = useState<'compose' | 'shell'>('compose');
  const [snippet, setSnippet] = useState<SnippetResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnippet(null);
    setErr(null);
    (async () => {
      try {
        const r = await fetch('/api/step-zero/instrument/snippet', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, serviceName: SERVICE_NAME_PLACEHOLDER, endpointMode }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SnippetResponse;
        if (!cancelled) setSnippet(data);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [language, endpointMode]);

  const copy = async (kind: CopyKind, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const CopyButton: React.FC<{ kind: CopyKind; text: string | undefined }> = ({ kind, text }) => (
    <button
      onClick={() => text && copy(kind, text)}
      disabled={!text}
      className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-60"
    >
      {copied === kind ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
      {copied === kind ? 'Copied' : 'Copy'}
    </button>
  );

  const CodeBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <pre className="bg-gray-1000 border border-gray-800 rounded p-4 text-base font-mono text-gray-200 overflow-x-auto whitespace-pre leading-relaxed">
      {children}
    </pre>
  );

  return (
    <div className="space-y-8">
      {/* ─── Zero-code section ─────────────────────────── */}
      <section>
        <h3 className="text-h3 font-semibold text-gray-100 mb-2">Zero-code auto-instrumentation</h3>
        <p className="text-base text-gray-300 mb-5 leading-relaxed">
          Drop these env vars (and, for Java, the agent JAR) onto your {LANG_LABEL[language]} container. No code changes required.
        </p>

        <div className="mb-5">
          <div className="text-tiny uppercase tracking-wider text-gray-500 mb-2">Endpoint context</div>
          <div className="flex items-center gap-1 text-sm">
            {(['compose', 'standalone', 'host'] as EndpointMode[]).map(m => (
              <button
                key={m}
                onClick={() => setEndpointMode(m)}
                className={`px-3 py-1.5 rounded ${endpointMode === m ? 'bg-primary text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >
                {m === 'compose' ? 'Docker compose' : m === 'standalone' ? 'Standalone container' : 'Host process'}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1 text-tiny">
              {(['compose', 'shell'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setSnippetTab(t)}
                  className={`px-2.5 py-1 rounded uppercase tracking-wider ${snippetTab === t ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  {t === 'compose' ? 'Compose patch' : 'Shell wrapper'}
                </button>
              ))}
            </div>
            <CopyButton
              kind={snippetTab}
              text={snippet ? (snippetTab === 'compose' ? snippet.compose : snippet.shell) : undefined}
            />
          </div>
          <CodeBlock>
{err ? `Failed to load snippet: ${err}` : (snippet ? (snippetTab === 'compose' ? snippet.compose : snippet.shell) : 'Loading…')}
          </CodeBlock>
        </div>

        {snippet?.prereqs && (
          <div className="rounded border border-gray-800 bg-gray-900 p-4 text-base text-gray-300 mb-4 leading-relaxed">
            <div className="inline-flex items-center gap-2 text-gray-100 font-semibold mb-2">
              <Info className="w-4 h-4" /> Prerequisites
            </div>
            <div className="whitespace-pre-wrap">{snippet.prereqs}</div>
          </div>
        )}

        {snippet?.agentDownload && (
          <div className="text-base text-gray-400 mb-3">
            Agent JAR download:{' '}
            <a href={snippet.agentDownload} target="_blank" rel="noopener noreferrer"
              className="text-link hover:underline inline-flex items-center gap-1 break-all">
              {snippet.agentDownload}
              <ExternalLink className="w-4 h-4 flex-shrink-0" />
            </a>
          </div>
        )}

        {snippet?.zeroCodeDocsUrl && (
          <a
            href={snippet.zeroCodeDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-base text-link hover:underline"
          >
            Official OpenTelemetry zero-code guide for {LANG_LABEL[language]}
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </section>

      {/* ─── Manual section ────────────────────────────── */}
      <section className="border-t border-gray-800 pt-7">
        <h3 className="text-h3 font-semibold text-gray-100 mb-2">Manual instrumentation (full SDK control)</h3>
        <p className="text-base text-gray-300 mb-5 leading-relaxed">
          Use the SDK directly when you want custom spans, sampling decisions, or attributes the auto-instrumentation doesn't capture.
        </p>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-tiny uppercase tracking-wider text-gray-500">Install</div>
            <CopyButton kind="manual-install" text={snippet?.manual.install} />
          </div>
          <CodeBlock>{snippet?.manual.install ?? 'Loading…'}</CodeBlock>
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-tiny uppercase tracking-wider text-gray-500">Initialize the SDK (once at startup)</div>
            <CopyButton kind="manual-init" text={snippet?.manual.init} />
          </div>
          <CodeBlock>{snippet?.manual.init ?? 'Loading…'}</CodeBlock>
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-tiny uppercase tracking-wider text-gray-500">Wrap an operation in a span</div>
            <CopyButton kind="manual-span" text={snippet?.manual.spanExample} />
          </div>
          <CodeBlock>{snippet?.manual.spanExample ?? 'Loading…'}</CodeBlock>
        </div>

        {snippet?.manual.docsUrl && (
          <a
            href={snippet.manual.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-base text-link hover:underline"
          >
            Official OpenTelemetry SDK docs for {LANG_LABEL[language]}
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </section>
    </div>
  );
};
