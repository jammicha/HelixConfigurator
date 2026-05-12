import React, { useState } from 'react';
import { Check } from 'lucide-react';

// Code/config snippet block with a corner Copy button. Text remains selectable
// (no whole-block click handler) so users can highlight just a section.
export const SnippetBlock: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can still select+Cmd-C */ }
  };
  return (
    <div className="relative bg-gray-1000 rounded border border-gray-800 mb-6 overflow-hidden">
      <pre
        className="font-mono text-tiny text-gray-300 p-4 pr-20 overflow-x-auto select-text"
        style={{ fontFamily: "'Source Code Pro', monospace" }}
      >{text}</pre>
      <button
        type="button"
        onClick={onCopy}
        className={`absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 text-tiny rounded border transition-colors ${copied ? 'bg-success/20 text-[#5eead4] border-success/50' : 'bg-gray-900 hover:bg-gray-800 text-gray-300 border-gray-700'}`}
      >
        {copied && <Check className="w-3 h-3" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
};
