import type { MutableRefObject } from 'react';
import Editor from '@monaco-editor/react';
import { ChevronDown, Loader2 } from 'lucide-react';

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  onLoadTemplate: () => void;
  onSave: () => void;
  isSaving: boolean;
  config: string;
  onConfigChange: (value: string) => void;
  editorRef: MutableRefObject<any>;
  // Invoked by the editor's Ctrl/Cmd+S binding. Kept separate from onSave so
  // the caller can route it through a ref and avoid a stale-closure save.
  onSaveShortcut: () => void;
};

// Collapsible Monaco editor for the gateway YAML, with Load Template / Save
// actions. Save-on-Ctrl+S is wired in onMount against the live editor.
export const GatewayConfigEditor = ({
  isOpen,
  onToggle,
  onLoadTemplate,
  onSave,
  isSaving,
  config,
  onConfigChange,
  editorRef,
  onSaveShortcut,
}: Props) => (
  <div className={`adapt-card flex flex-col ${isOpen ? 'h-[500px]' : ''}`}>
    <div className="flex items-center justify-between">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 flex-1 text-left group"
      >
        <h2 className="text-base font-semibold text-gray-200 flex-1">Gateway Config (YAML)</h2>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="flex items-center gap-2 ml-4 flex-shrink-0">
          <button
            onClick={onLoadTemplate}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-1.5 rounded text-sm font-semibold transition-colors"
          >
            Load Template
          </button>
          <button
            onClick={onSave}
            disabled={isSaving}
            className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-semibold transition-all flex items-center gap-2"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isSaving ? 'Saving...' : 'Save Config'}
          </button>
        </div>
      )}
    </div>
    {isOpen && (
      <div className="flex-1 border border-gray-800 rounded overflow-hidden mt-4">
        <Editor
          height="100%"
          defaultLanguage="yaml"
          theme="vs-dark"
          value={config}
          onMount={(editor, monacoInstance) => {
            editorRef.current = editor;
            editor.addCommand(
              monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
              () => { onSaveShortcut(); }
            );
          }}
          onChange={(v) => onConfigChange(v || '')}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 16 }
          }}
        />
      </div>
    )}
  </div>
);
