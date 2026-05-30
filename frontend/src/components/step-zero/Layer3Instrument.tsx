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
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
        onClick={toggle}
        role="button"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-3">
          <ChevronRight
            className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-blue-300 mb-0.5 font-semibold">Instrument your apps</div>
            <div className="text-sm font-semibold text-gray-100">Tailored OpenTelemetry guides</div>
          </div>
        </div>
        {collapsed && (
          <div className="text-xs text-gray-500 pr-2">click to expand</div>
        )}
      </header>

      {!collapsed && (
        <div className="px-4 pb-4">
          <p className="text-xs text-gray-400 mb-3 leading-relaxed">
            Pick your language for pre-configured OpenTelemetry snippets. Endpoint, service name, and protocol are already wired for Helix.
          </p>

          {/* Language tab bar */}
          <div role="tablist" className="flex items-center gap-1 mb-4 border-b border-gray-800">
            {LANGS.map(l => (
              <button
                key={l.id}
                role="tab"
                aria-selected={language === l.id}
                onClick={() => pickLanguage(l.id)}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors ${
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
