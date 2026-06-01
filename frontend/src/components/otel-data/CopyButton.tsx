import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Compact, reusable copy-to-clipboard control for the OTel viewer. Trace IDs and
// span attributes are constantly lifted out of this UI and pasted into queries,
// support tickets, and other tools, so every surface that shows a copyable value
// gets one of these instead of forcing a manual select + Cmd-C. Mirrors the
// SnippetBlock copy idiom (1.5s "Copied" confirmation) and fails silently when
// the Clipboard API is blocked (insecure origin / denied permission) — the value
// stays selectable in the DOM as the fallback.
export const CopyButton: React.FC<{
  value: string;
  // Optional visible label. Omit for an icon-only button (dense table rows /
  // headers); pass e.g. "Copy all" for the span attributes panel.
  label?: string;
  title?: string;
  className?: string;
  // Trace rows open the detail drawer on click and span rows toggle their detail
  // panel; nested copy buttons must not also fire those, so the click is stopped
  // by default. Set false for standalone placements.
  stopPropagation?: boolean;
}> = ({ value, label, title, className = '', stopPropagation = true }) => {
  const [copied, setCopied] = useState(false);
  // Hold the "Copied" reset timer so a rapid second click doesn't leave the
  // first timer live (which would revert the checkmark early), and so it's
  // cleared on unmount.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const onCopy = async (e: React.MouseEvent) => {
    if (stopPropagation) {
      e.stopPropagation();
      e.preventDefault();
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — value stays selectable in the DOM */
    }
  };
  const a11y = title || `Copy ${label || 'to clipboard'}`;
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? 'Copied' : a11y}
      aria-label={a11y}
      className={`inline-flex items-center gap-1 transition-colors ${copied ? 'text-[#5eead4]' : 'text-gray-500 hover:text-gray-200'} ${className}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
      {label && <span className="text-tiny font-semibold">{copied ? 'Copied' : label}</span>}
    </button>
  );
};
