import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Language } from './instrument-types';
import { LanguageGuide } from './LanguageGuide';

const COLLAPSED_KEY = 'helix-configurator.layer3.collapsed';
const LANG_KEY = 'helix-configurator.layer3.language';

const LANGS: { id: Language; label: string }[] = [
  { id: 'java',   label: 'Java' },
  { id: 'python', label: 'Python' },
  { id: 'dotnet', label: '.NET' },
  { id: 'node',   label: 'Node.js' },
];

const isLanguage = (s: string | null): s is Language =>
  s === 'java' || s === 'python' || s === 'dotnet' || s === 'node';

export const Layer3Instrument: React.FC = () => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const val = localStorage.getItem(COLLAPSED_KEY);
      return val === null ? true : val === '1';
    } catch { return true; }
  });
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      return isLanguage(stored) ? stored : 'java';
    } catch { return 'java'; }
  });

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch {}
  };

  const pickLanguage = (l: Language) => {
    setLanguage(l);
    try { localStorage.setItem(LANG_KEY, l); } catch {}
  };

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000">
      <header
        className="flex items-center justify-between px-6 py-4 cursor-pointer select-none"
        onClick={toggle}
        role="button"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-3">
          <ChevronRight
            className={`w-5 h-5 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <div>
            <div className="text-tiny uppercase tracking-wider text-blue-300 mb-1 font-semibold">Instrument your apps</div>
            <div className="text-h3 font-semibold text-gray-100">Tailored OpenTelemetry guides</div>
          </div>
        </div>
        {collapsed && (
          <div className="text-sm text-gray-500">click to expand</div>
        )}
      </header>

      {!collapsed && (
        <div className="px-6 pb-6">
          <p className="text-base text-gray-300 mb-5 leading-relaxed">
            Pick your language for pre-configured OpenTelemetry snippets. Endpoint, service name, and protocol are already wired for Helix.
          </p>

          {/* Language tab bar */}
          <div role="tablist" className="flex items-center gap-1 mb-6 border-b border-gray-800">
            {LANGS.map(l => (
              <button
                key={l.id}
                role="tab"
                aria-selected={language === l.id}
                onClick={() => pickLanguage(l.id)}
                className={`px-4 py-2.5 text-base border-b-2 -mb-px transition-colors ${
                  language === l.id
                    ? 'border-primary text-gray-100 font-semibold'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>

          <LanguageGuide language={language} />
        </div>
      )}
    </section>
  );
};
