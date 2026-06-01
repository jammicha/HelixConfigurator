import { useState } from 'react';
import type { Template } from '../components/TemplatesModal';
import type { ShowToast } from './useToasts';

type Deps = {
  showToast: ShowToast;
  // Load the chosen template's YAML into the editor (caller wires this to
  // setConfig + clearEditorMarkers). Kept as a callback so the hook stays
  // agnostic about the editor.
  onApplyConfig: (content: string) => void;
};

// Config-template picker modal: lazy-loads the template list on first open,
// and on apply fetches the chosen template's YAML and hands it to the editor.
export const useTemplates = ({ showToast, onApplyConfig }: Deps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(null);

  const open = async () => {
    setIsOpen(true);
    if (templates.length === 0) {
      try {
        const res = await fetch('/api/templates');
        const data = await res.json();
        if (Array.isArray(data)) setTemplates(data);
      } catch {
        showToast('Failed to load templates', 'error');
      }
    }
  };

  const close = () => setIsOpen(false);

  const apply = async (id: string) => {
    setLoadingTemplateId(id);
    try {
      const res = await fetch(`/api/templates/${id}`);
      if (!res.ok) {
        showToast('Failed to load template', 'error');
        return;
      }
      const data = await res.json();
      onApplyConfig(data.content || '');
      setIsOpen(false);
      showToast('Template loaded. Review and click Save Config to apply.');
    } catch {
      showToast('Failed to load template', 'error');
    } finally {
      setLoadingTemplateId(null);
    }
  };

  return { isOpen, templates, loadingTemplateId, open, close, apply };
};
