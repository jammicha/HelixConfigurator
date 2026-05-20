import { useEffect, useState } from 'react';

export type SmartAddProposal = {
  name: string;
  configPath: string;
  hostConfigPath?: string | null;
  alreadyConfigured?: boolean;
  existingExporterName?: string;
  exporterName?: string;
  addedToPipelines?: string[];
  existingPipelines?: string[];
  proposedYaml?: string;
  error?: string;
};

export type SmartAddResult = { ok: boolean; message: string };

// When smart-add detects the gateway isn't yet on a network the target
// collector shares, the backend skips the post-apply restart and surfaces
// the container name here so the wizard can trigger the restart later
// (after Step 3's bridge attaches the gateway to a reachable network).
export type PendingCollectorRestart = { containerName: string } | null;

type DetectedCollector = { name: string };

type Args = {
  setupStep: number;
  isSetupComplete: boolean;
  detectedCollectors: DetectedCollector[];
  refreshDetectedCollectors: () => void;
};

export type UseSmartAdd = {
  proposal: SmartAddProposal | null;
  loading: boolean;
  applying: boolean;
  result: SmartAddResult | null;
  previewOpen: boolean;
  setPreviewOpen: (open: boolean) => void;
  apply: (collectorName: string) => Promise<void>;
  dismissResult: () => void;
  refresh: (collectorName: string) => Promise<void>;
  pendingRestart: PendingCollectorRestart;
  clearPendingRestart: () => void;
};

export function useSmartAdd({
  setupStep,
  isSetupComplete,
  detectedCollectors,
  refreshDetectedCollectors,
}: Args): UseSmartAdd {
  const [proposal, setProposal] = useState<SmartAddProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<SmartAddResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingRestart, setPendingRestart] = useState<PendingCollectorRestart>(null);

  const refreshProposal = async (collectorName: string) => {
    setLoading(true);
    setProposal(null);
    try {
      const res = await fetch(`/api/discovery/collector-config/${encodeURIComponent(collectorName)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Combine error + details so the user sees the actionable reason
        // (e.g. "tried 5 paths, none returned valid OTel collector YAML")
        // rather than just the generic title.
        const headline = data.error || 'Could not read collector config';
        const detail = data.details && data.details !== headline ? ` ${data.details}` : '';
        setProposal({ name: collectorName, configPath: '', error: `${headline}.${detail}` });
        return;
      }
      setProposal({
        name: data.name,
        configPath: data.configPath,
        hostConfigPath: data.hostConfigPath,
        alreadyConfigured: data.alreadyConfigured,
        existingExporterName: data.existingExporterName,
        exporterName: data.exporterName,
        addedToPipelines: data.addedToPipelines,
        existingPipelines: data.existingPipelines,
        proposedYaml: data.proposedYaml,
      });
    } catch (e: any) {
      setProposal({ name: collectorName, configPath: '', error: e?.message || 'Network error' });
    } finally {
      setLoading(false);
    }
  };

  const apply = async (collectorName: string) => {
    if (applying) return;
    setApplying(true);
    setResult(null);
    try {
      const res = await fetch(`/api/discovery/collector-apply/${encodeURIComponent(collectorName)}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const summary = data.error || 'Apply failed';
        const message = data.details ? `${summary}: ${data.details}` : summary;
        setResult({ ok: false, message });
        setPreviewOpen(false);
        return;
      }
      if (data.alreadyConfigured) {
        setResult({ ok: true, message: `Already configured. ${data.existingExporterName} already points at helix-gateway:4318. No changes needed.` });
      } else if (data.restartDeferred && data.containerName) {
        // Backend skipped the restart because the gateway isn't on this
        // collector's network yet. Stash the container name so the wizard
        // can trigger the restart after Step 3's bridge succeeds.
        setPendingRestart({ containerName: data.containerName });
        setResult({
          ok: true,
          message: `Applied. ${data.exporterName} added to ${(data.addedToPipelines || []).join(', ') || '(no pipelines)'} on ${collectorName}. Restart deferred until Step 3 attaches the gateway to this collector's network.`,
        });
      } else {
        setResult({
          ok: true,
          message: `Applied. ${data.exporterName} added to ${(data.addedToPipelines || []).join(', ') || '(no pipelines)'} on ${collectorName}. Original saved as ${data.backupPath}. Container restarting.`,
        });
      }
      setPreviewOpen(false);
      refreshDetectedCollectors();
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || 'Network error' });
    } finally {
      setApplying(false);
    }
  };

  // Auto-fetch proposal when entering Step 2 with exactly one detected
  // collector. Re-fetch when the detected collector identity changes.
  useEffect(() => {
    if (isSetupComplete || setupStep !== 2) return;
    if (detectedCollectors.length === 1) {
      const name = detectedCollectors[0].name;
      if (!proposal || proposal.name !== name) {
        refreshProposal(name);
      }
    } else {
      setProposal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStep, isSetupComplete, detectedCollectors.length, detectedCollectors[0]?.name]);

  const dismissResult = () => setResult(null);

  // Re-run the proposal fetch on demand. Used by the "Verify exporter"
  // affordance on Step 2 so the user can re-check after applying the snippet
  // by hand and restarting their collector.
  const refresh = async (collectorName: string) => {
    setResult(null);
    await refreshProposal(collectorName);
  };

  const clearPendingRestart = () => setPendingRestart(null);

  return {
    proposal, loading, applying, result, previewOpen, setPreviewOpen,
    apply, dismissResult, refresh,
    pendingRestart, clearPendingRestart,
  };
}
