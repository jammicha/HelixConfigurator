# Target-branched Onboarding (Docker vs Kubernetes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kubernetes a first-class onboarding path: a target selector at the top of the wizard, a shared universal spine (creds → verify → link), and Kubernetes step bodies (generate the chart → point apps at the Service DNS → verify by guidance) that replace the Docker-specific exporter/network-bridge steps.

**Architecture:** Frontend-only. One adaptive 5-step wizard keyed by a new `target: 'docker' | 'kubernetes'` (localStorage). Universal steps (1 form, 5) are shared; `Step2/3/4` render a `…K8s` sibling when the target is Kubernetes. The proven Docker components are untouched. The Phase 1 chart routes (`/api/k8s/chart*`) and `POST /api/env` (which already reloads `process.env`) are reused with **zero backend changes**. The dashboard `K8sChartModal` and the wizard's K8s step share one extracted `<K8sChartPanel>`.

**Tech Stack:** React + Vite + TypeScript + Tailwind (frontend), `vitest` (pure-util tests), `lucide-react` icons, the repo's `SnippetBlock` / `adapt-card` conventions.

**Spec:** [`docs/superpowers/specs/2026-06-04-k8s-onboarding-branch-design.md`](../specs/2026-06-04-k8s-onboarding-branch-design.md)

**Commit convention:** end every commit message with a trailer line `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. All commands assume the working directory is the worktree root (`.worktrees/k8s-onboarding-branch`).

---

## File Structure

**New — pure logic + tests:**
- `frontend/src/components/wizard/wizardTargets.ts` — `WizardTarget`, `getWizardSteps`, `k8sGatewayEndpoint`, `isWizardTargetOrNull` (the TDD core).
- `frontend/src/components/wizard/wizardTargets.test.ts`

**New — shared/extracted components:**
- `frontend/src/components/K8sChartPanel.tsx` — the generate-chart UX body (toggles, install steps, previews, download), extracted from `K8sChartModal`.
- `frontend/src/components/wizard/NamespaceRecipe.tsx` — the multi-app `service.namespace` snippet, extracted from `Step2`.

**New — Kubernetes step bodies + selector:**
- `frontend/src/components/wizard/Step2K8s.tsx` — wraps `<K8sChartPanel>` + nav.
- `frontend/src/components/wizard/Step3K8s.tsx` — point apps at the gateway Service DNS.
- `frontend/src/components/wizard/Step4K8s.tsx` — verify-by-guidance.
- `frontend/src/components/wizard/TargetSelector.tsx` — the "Where will this run?" card grid.

**Modified:**
- `frontend/src/components/wizard/Stepper.tsx` — take a `steps` prop.
- `frontend/src/components/wizard/Step1.tsx` — `primaryLabel` prop (target-aware button).
- `frontend/src/components/wizard/Step2.tsx` — use `<NamespaceRecipe>`.
- `frontend/src/components/K8sChartModal.tsx` — wrap `<K8sChartPanel>`.
- `frontend/src/App.tsx` — `target` state, selector gate, render branches, Step-1 commit branch, Docker-effect gating, target chip, reset clears target.
- `README.md` — short note on the branched onboarding.

---

## Task 0: Worktree dependency setup

**Files:** none (creates gitignored symlinks; **no commit**).

> The worktree was created without `node_modules`. Symlink the main checkout's installed deps so `npm` commands work. `node_modules` is gitignored — this task is setup only, never committed.

- [ ] **Step 1: Symlink node_modules from the main checkout**

Run (from the worktree root):
```bash
ln -sfn /Users/jammicha/dev/HelixConfigurator/node_modules node_modules
ln -sfn /Users/jammicha/dev/HelixConfigurator/frontend/node_modules frontend/node_modules
ln -sfn /Users/jammicha/dev/HelixConfigurator/backend/node_modules backend/node_modules
```

- [ ] **Step 2: Verify the toolchain resolves**

Run: `npm --prefix frontend run build`
Expected: a clean production build (no TypeScript errors). This is the green baseline before any change.

---

## Task 1: `wizardTargets` pure helpers (TDD core)

**Files:**
- Create: `frontend/src/components/wizard/wizardTargets.ts`
- Test: `frontend/src/components/wizard/wizardTargets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/components/wizard/wizardTargets.test.ts
import { describe, it, expect } from 'vitest';
import {
  getWizardSteps,
  k8sGatewayEndpoint,
  isWizardTarget,
  isWizardTargetOrNull,
} from './wizardTargets';

describe('getWizardSteps', () => {
  it('docker labels', () => {
    expect(getWizardSteps('docker').map(s => s.label))
      .toEqual(['Configure', 'Exporter', 'Connect', 'Verify', 'Link Service']);
  });
  it('kubernetes labels', () => {
    expect(getWizardSteps('kubernetes').map(s => s.label))
      .toEqual(['Configure', 'Generate', 'Point apps', 'Verify', 'Link Service']);
  });
  it('always 5 steps numbered 1..5', () => {
    for (const t of ['docker', 'kubernetes'] as const) {
      const s = getWizardSteps(t);
      expect(s).toHaveLength(5);
      expect(s.map(x => x.n)).toEqual([1, 2, 3, 4, 5]);
    }
  });
});

describe('k8sGatewayEndpoint', () => {
  it('builds the FQDN for a namespace', () => {
    expect(k8sGatewayEndpoint('payments'))
      .toBe('http://helix-gateway.payments.svc.cluster.local:4318');
  });
  it('defaults to the default namespace when empty/blank/missing', () => {
    const expected = 'http://helix-gateway.default.svc.cluster.local:4318';
    expect(k8sGatewayEndpoint()).toBe(expected);
    expect(k8sGatewayEndpoint('')).toBe(expected);
    expect(k8sGatewayEndpoint('   ')).toBe(expected);
  });
  it('trims whitespace', () => {
    expect(k8sGatewayEndpoint('  ns ')).toBe('http://helix-gateway.ns.svc.cluster.local:4318');
  });
});

describe('isWizardTarget / isWizardTargetOrNull', () => {
  it('accepts valid targets', () => {
    expect(isWizardTarget('docker')).toBe(true);
    expect(isWizardTarget('kubernetes')).toBe(true);
  });
  it('rejects junk and null for isWizardTarget', () => {
    expect(isWizardTarget('nomad')).toBe(false);
    expect(isWizardTarget(null)).toBe(false);
    expect(isWizardTarget(3)).toBe(false);
  });
  it('isWizardTargetOrNull accepts null + valid targets, rejects junk', () => {
    expect(isWizardTargetOrNull(null)).toBe(true);
    expect(isWizardTargetOrNull('docker')).toBe(true);
    expect(isWizardTargetOrNull('x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true npm --prefix frontend test -- --run wizardTargets`
Expected: FAIL — cannot resolve `./wizardTargets`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/components/wizard/wizardTargets.ts
// Pure helpers for the target-branched onboarding wizard. The `target`
// (docker | kubernetes) is chosen on the selector screen and drives per-step
// labels and the Kubernetes Service-DNS endpoint. Dependency-free + pure so it's
// unit-tested (the TDD core of this round).

export type WizardTarget = 'docker' | 'kubernetes';

export function isWizardTarget(v: unknown): v is WizardTarget {
  return v === 'docker' || v === 'kubernetes';
}

// localStorage validator: null (no choice yet) or a valid target.
export function isWizardTargetOrNull(v: unknown): v is WizardTarget | null {
  return v === null || isWizardTarget(v);
}

export type WizardStep = { n: number; label: string };

const DOCKER_STEPS: WizardStep[] = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Exporter' },
  { n: 3, label: 'Connect' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];

const KUBERNETES_STEPS: WizardStep[] = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Generate' },
  { n: 3, label: 'Point apps' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];

export function getWizardSteps(target: WizardTarget): WizardStep[] {
  return target === 'kubernetes' ? KUBERNETES_STEPS : DOCKER_STEPS;
}

// The in-cluster OTLP/HTTP endpoint apps use to reach the gateway Service. The
// Phase 1 chart names the Service `helix-gateway` (stable, release-independent),
// so the FQDN is helix-gateway.<ns>.svc.cluster.local:4318. Apps in the gateway's
// own namespace can use the short form http://helix-gateway:4318.
export function k8sGatewayEndpoint(namespace: string = 'default'): string {
  const ns = (namespace || 'default').trim() || 'default';
  return `http://helix-gateway.${ns}.svc.cluster.local:4318`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `CI=true npm --prefix frontend test -- --run wizardTargets`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/wizard/wizardTargets.ts frontend/src/components/wizard/wizardTargets.test.ts
git commit -m "feat(k8s): wizardTargets pure helpers (steps, endpoint, validator)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extract `K8sChartPanel` + refactor `K8sChartModal`

**Files:**
- Create: `frontend/src/components/K8sChartPanel.tsx`
- Modify: `frontend/src/components/K8sChartModal.tsx`

> The modal's body becomes a reusable panel so the wizard's K8s step renders the exact same generate UX. The panel fetches the preview on mount (the modal only mounts it when open, so behavior is unchanged). The download action moves into the panel (so both surfaces have it).

- [ ] **Step 1: Create `frontend/src/components/K8sChartPanel.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { SnippetBlock } from './SnippetBlock';

type Preview = {
  values: string;
  gatewayConfig: string;
  secretCommand: string;
  installCommand: string;
  files: string[];
  keyEmbedded: boolean;
};

// The generate-a-Helm-chart UX, shared by the dashboard K8sChartModal and the
// onboarding wizard's Kubernetes "Generate" step. Self-contained: owns the
// viewer/handoff toggles, fetches the preview, and renders the install steps +
// previews + download. Generate-only — no cluster calls.
export const K8sChartPanel: React.FC = () => {
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?viewer=${viewerEnabled}&handoff=${handoff}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewerEnabled, handoff]);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 text-sm text-gray-300">
        <input type="checkbox" checked={viewerEnabled} onChange={e => setViewerEnabled(e.target.checked)} className="accent-primary w-4 h-4" />
        Include the local &quot;View OTel Data&quot; viewer (Deployment + PVC)
      </label>

      <label className="flex items-center gap-3 text-sm text-gray-300">
        <input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} className="accent-primary w-4 h-4" />
        Generating this for someone else (omit my key)
      </label>

      <div className="flex items-center gap-3 text-sm text-gray-500">
        <input type="checkbox" checked={false} disabled className="w-4 h-4" />
        Use the OpenTelemetry Operator <span className="text-tiny px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700">coming soon</span>
      </div>

      {error && <div className="text-xs text-error-text bg-error/10 border border-error/40 rounded p-3">{error}</div>}
      {loading && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</div>}

      {preview && !loading && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-tiny uppercase tracking-wide text-gray-500">Install steps</p>
            <a
              href="https://github.com/jammicha/HelixConfigurator#generate-a-kubernetes-chart"
              target="_blank" rel="noopener noreferrer"
              className="text-tiny text-[#8b7cf6] hover:underline"
            >Full walkthrough ↗</a>
          </div>
          <div>
            <p className="text-sm text-gray-300">
              <span className="text-gray-500">1 ·</span> Download &amp; unzip the chart — click <span className="text-gray-200">Download chart (.zip)</span> below, then <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">unzip helix-otel-chart.zip</code>. Run the next steps from the folder that now holds <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">helix-otel/</code>.
            </p>
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">2 · Create the secret</p>
            <SnippetBlock text={preview.secretCommand} />
            {preview.keyEmbedded && (
              <p className="text-tiny text-[#fcd34d] mb-2">
                ⚠ Contains your live Helix key — it runs locally and is never written into the downloaded chart.
              </p>
            )}
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">3 · Install the chart</p>
            <SnippetBlock text={preview.installCommand} />
          </div>
          <details>
            <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview values.yaml</summary>
            <SnippetBlock text={preview.values} />
          </details>
          <details>
            <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview gateway collector config</summary>
            <SnippetBlock text={preview.gatewayConfig} />
          </details>
        </>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        <a
          href={`/api/k8s/chart?viewer=${viewerEnabled}`}
          className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
        >
          <Download className="w-4 h-4" /> Download chart (.zip)
        </a>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Replace `frontend/src/components/K8sChartModal.tsx` with the thin wrapper**

```tsx
import React from 'react';
import { X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { K8sChartPanel } from './K8sChartPanel';

type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — dashboard re-entry. Dialog chrome around the
// shared K8sChartPanel (the same panel the onboarding wizard's Kubernetes step uses).
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="k8s-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="k8s-modal-title" className="text-lg font-semibold text-gray-200">Generate Kubernetes deployment</h2>
            <p className="text-tiny text-gray-500">A self-contained Helm chart, pre-wired to Helix from your current config.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close dialog">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <K8sChartPanel />
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Build to verify (typecheck + the dashboard modal still compiles)**

Run: `npm --prefix frontend run build`
Expected: build succeeds. (The dashboard "Generate Kubernetes deployment" button now renders the extracted panel; behavior is unchanged except the download button sits at the panel's bottom instead of a separate sticky footer.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/K8sChartPanel.tsx frontend/src/components/K8sChartModal.tsx
git commit -m "refactor(k8s): extract K8sChartPanel for reuse in the wizard" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Extract `NamespaceRecipe` + use it in `Step2`

**Files:**
- Create: `frontend/src/components/wizard/NamespaceRecipe.tsx`
- Modify: `frontend/src/components/wizard/Step2.tsx`

> The "Onboarding more than one app?" block is identical guidance for Docker and Kubernetes (set a distinct `service.namespace`). Extract it so both steps share one source; the target-specific footnote is a prop.

- [ ] **Step 1: Create `frontend/src/components/wizard/NamespaceRecipe.tsx`**

```tsx
import React from 'react';
import { Layers } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

type Props = {
  // Target-specific footnote (e.g. Docker's smart-add caveat, or the K8s
  // collector-ConfigMap note). Rendered before the shared README pointer.
  extraNote?: React.ReactNode;
};

// "Onboarding more than one app?" — each app needs a distinct service.namespace to
// land as its own OTel Namespace and roll up to a Business Service; the shared
// X-Source can't separate them. App-side config (documented, not edited for the
// user). Shared by the Docker exporter step and the Kubernetes "point apps" step.
export const NamespaceRecipe: React.FC<Props> = ({ extraNote }) => (
  <div className="mb-6 p-4 bg-gray-1000 border border-active/40 rounded">
    <div className="flex items-center gap-2 mb-2">
      <Layers className="w-4 h-4 text-link" />
      <span className="text-sm font-semibold text-gray-100">Onboarding more than one app?</span>
      <span className="ml-auto text-tiny text-gray-500">Optional</span>
    </div>
    <p className="text-tiny text-gray-300 mb-3">
      The gateway uses a shared <code className="font-mono text-gray-200">X-Source</code> header for all apps. To keep
      them separate in Helix, give each app a distinct <code className="font-mono text-gray-200">service.namespace</code>.
      This ensures they appear as individual <span className="text-gray-200">OTel Namespaces</span> rolling up to one
      Business Service. Set these variables on the app:
    </p>
    <SnippetBlock text={`OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=service.namespace=<app>,deployment.environment=<env>`} />
    <p className="text-tiny text-gray-500 -mt-4">
      {extraNote}{extraNote ? ' ' : ''}To bind namespaces to a Business Service in AIOps, see the{' '}
      <span className="text-gray-300">Onboarding multiple applications</span> section of the README.
    </p>
  </div>
);
```

- [ ] **Step 2: In `frontend/src/components/wizard/Step2.tsx`, add the import**

Add after the existing `SnippetBlock` import (line 3):
```tsx
import { NamespaceRecipe } from './NamespaceRecipe';
```

- [ ] **Step 3: In `Step2.tsx`, replace the inline namespace block with `<NamespaceRecipe>`**

Replace the entire block that starts with the comment `{/* Namespace recipe — always visible…` and the `<div className="mb-6 p-4 bg-gray-1000 border border-active/40 rounded">…</div>` it wraps (the block rendering "Onboarding more than one app?", through its closing `</div>` before `<div className="flex gap-4">`) with:

```tsx
    {/* Multi-app namespace recipe — shared with the Kubernetes "point apps"
        step via NamespaceRecipe. Docker's footnote keeps the smart-add caveat. */}
    <NamespaceRecipe
      extraNote={
        <>
          The smart-add tool automatically wires the exporter, but it does not set the namespace — set that with the
          variables above. If you cannot set the environment variables on the app, add a{' '}
          <code className="font-mono">resource</code> processor to its collector instead.
        </>
      }
    />
```

- [ ] **Step 4: Build to verify**

Run: `npm --prefix frontend run build`
Expected: build succeeds; Docker Step 2 renders the same recipe block (now via `NamespaceRecipe`). If a TypeScript "unused import `Layers`" error appears in `Step2.tsx`, remove `Layers` from its `lucide-react` import line (it moved into `NamespaceRecipe`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/wizard/NamespaceRecipe.tsx frontend/src/components/wizard/Step2.tsx
git commit -m "refactor(wizard): extract NamespaceRecipe shared by Docker + K8s steps" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The Kubernetes step bodies (`Step2K8s`, `Step3K8s`, `Step4K8s`)

**Files (all Create):**
- `frontend/src/components/wizard/Step2K8s.tsx`
- `frontend/src/components/wizard/Step3K8s.tsx`
- `frontend/src/components/wizard/Step4K8s.tsx`

> These compile standalone (exported, not yet rendered — wired into `App.tsx` in Task 6).

- [ ] **Step 1: Create `frontend/src/components/wizard/Step2K8s.tsx`**

```tsx
import React from 'react';
import { K8sChartPanel } from '../K8sChartPanel';

type Props = { onBack: () => void; onNext: () => void };

// Kubernetes Step 2 — "Generate": stand up the gateway by generating and
// helm-installing the chart. Reuses the shared K8sChartPanel; the next step
// points apps at the now-existing Service.
export const Step2K8s: React.FC<Props> = ({ onBack, onNext }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 2: Generate your Kubernetes deployment</h2>
    <p className="text-sm text-gray-400 mb-4">
      Download a self-contained Helm chart, pre-wired to Helix from the credentials you just saved, and{' '}
      <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helm install</code> it in your cluster. You can
      install now or come back to it — the next step shows your apps where to send telemetry.
    </p>
    <K8sChartPanel />
    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Point apps →</button>
    </div>
  </div>
);
```

- [ ] **Step 2: Create `frontend/src/components/wizard/Step3K8s.tsx`**

```tsx
import React, { useState } from 'react';
import { SnippetBlock } from '../SnippetBlock';
import { NamespaceRecipe } from './NamespaceRecipe';
import { k8sGatewayEndpoint } from './wizardTargets';

type Props = { onBack: () => void; onNext: () => void };

// Kubernetes Step 3 — "Point apps": point instrumented apps (or the user's own
// collector) at the gateway's in-cluster Service DNS. No Docker socket, no
// bridging — a Service gives the gateway a stable DNS name.
export const Step3K8s: React.FC<Props> = ({ onBack, onNext }) => {
  const [namespace, setNamespace] = useState('default');
  const endpoint = k8sGatewayEndpoint(namespace);
  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 3: Point your apps at the gateway</h2>
      <p className="text-sm text-gray-400 mb-4">
        Once the chart is installed, the gateway is reachable in-cluster at its Service DNS name. Point your
        instrumented apps (or your own collector) at it.
      </p>

      <div className="mb-4">
        <label htmlFor="k8s-namespace" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Gateway namespace</label>
        <input
          id="k8s-namespace"
          type="text"
          value={namespace}
          onChange={e => setNamespace(e.target.value)}
          spellCheck={false}
          className="mt-1 w-full max-w-xs bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 text-sm focus:outline-none focus:border-link block"
          placeholder="default"
        />
        <p className="text-tiny text-gray-500 mt-1">The namespace you <code className="font-mono">helm install</code>ed into (the <code className="font-mono">-n</code> flag).</p>
      </div>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option A · App sends OTLP directly</p>
      <SnippetBlock text={`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`} />
      <p className="text-tiny text-gray-500 -mt-4 mb-5">
        Set this on your app&apos;s Deployment. Apps in the gateway&apos;s own namespace can use the short form{' '}
        <code className="font-mono">http://helix-gateway:4318</code>.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option B · You run your own collector</p>
      <SnippetBlock text={`exporters:
  otlphttp/helix_gateway:
    endpoint: "${endpoint}"
    tls:
      insecure: true

service:
  pipelines:
    traces:  { exporters: [..., otlphttp/helix_gateway] }
    metrics: { exporters: [..., otlphttp/helix_gateway] }
    logs:    { exporters: [..., otlphttp/helix_gateway] }`} />
      <p className="text-tiny text-gray-500 -mt-4 mb-5">
        Add to your collector&apos;s ConfigMap, then <code className="font-mono">kubectl rollout restart deployment/&lt;your-collector&gt;</code>.
      </p>

      <NamespaceRecipe
        extraNote={<>If you can&apos;t set env vars on the app, add a <code className="font-mono">resource</code> processor to your collector&apos;s ConfigMap instead.</>}
      />

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
        <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Verify →</button>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Create `frontend/src/components/wizard/Step4K8s.tsx`**

```tsx
import React from 'react';
import { Hexagon, ExternalLink, ArrowRight } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

type Props = {
  otelDashboardUrl: string | null;
  onBack: () => void;
  onFinishStep: () => void;
};

// Kubernetes Step 4 — "Verify": generate-only can't read the user's cluster, so
// this is guidance (kubectl / port-forward) plus the universal "see it in Helix"
// deep-link. No live counters, nothing gates leaving the step.
export const Step4K8s: React.FC<Props> = ({ otelDashboardUrl, onBack, onFinishStep }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
    <p className="text-sm text-gray-400 mb-4">
      The configurator generated the chart but doesn&apos;t reach into your cluster — verify from your own{' '}
      <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">kubectl</code> and in Helix.
    </p>

    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">1 · Gateway pods are up</p>
        <SnippetBlock text={`kubectl get pods -l app.kubernetes.io/part-of=helix-otel -n <namespace>`} />
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">2 · Watch it locally (if you included the viewer)</p>
        <SnippetBlock text={`kubectl port-forward svc/helix-viewer 3001:3001 -n <namespace>`} />
        <p className="text-tiny text-gray-500 -mt-4">Then open <code className="font-mono">http://localhost:3001/otel-data</code>.</p>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">3 · See it in Helix</p>
        {otelDashboardUrl ? (
          <a href={otelDashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-link hover:underline text-sm font-semibold">
            <ExternalLink className="w-4 h-4" /> Open the OTel namespace dashboard
          </a>
        ) : (
          <p className="text-tiny text-gray-500">Set a real Helix endpoint in Step 1 to get a dashboard deep-link.</p>
        )}
      </div>
    </div>

    <div className="mt-5 flex items-start gap-3 p-2.5 rounded border border-primary/40 bg-primary/10 text-tiny text-gray-300">
      <Hexagon className="w-3.5 h-3.5 text-link flex-shrink-0 mt-0.5" />
      <span>Generate-only: the configurator can&apos;t read your cluster&apos;s gateway counters, so these checks run on your side. Live in-cluster verification is on the roadmap.</span>
    </div>

    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onFinishStep} className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm flex items-center justify-center gap-2">Next: Link your service <ArrowRight className="w-4 h-4" /></button>
    </div>
  </div>
);
```

- [ ] **Step 4: Build to verify all three compile**

Run: `npm --prefix frontend run build`
Expected: build succeeds (the three components are valid but not yet rendered).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/wizard/Step2K8s.tsx frontend/src/components/wizard/Step3K8s.tsx frontend/src/components/wizard/Step4K8s.tsx
git commit -m "feat(k8s): wizard Kubernetes step bodies (generate, point apps, verify)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The target selector screen

**Files:**
- Create: `frontend/src/components/wizard/TargetSelector.tsx`

- [ ] **Step 1: Create `frontend/src/components/wizard/TargetSelector.tsx`**

```tsx
import React from 'react';
import { Container, Ship } from 'lucide-react';
import type { WizardTarget } from './wizardTargets';

type Props = { onSelect: (t: WizardTarget) => void };

type Card = { target: WizardTarget; icon: React.ReactNode; title: string; tagline: string; detail: string };

// Extensible card grid — future targets (bare-metal / systemd) slot in as new
// entries without restructuring the wizard.
const CARDS: Card[] = [
  {
    target: 'docker',
    icon: <Container className="w-6 h-6" />,
    title: 'Docker Desktop / Compose',
    tagline: 'Run the gateway as a container next to your app.',
    detail: 'The configurator manages a helix-gateway container locally and bridges it onto your app’s network.',
  },
  {
    target: 'kubernetes',
    icon: <Ship className="w-6 h-6" />,
    title: 'Kubernetes',
    tagline: 'Generate a Helm chart you install in your cluster.',
    detail: 'We emit a self-contained chart pre-wired to Helix; you helm install it and point apps at the gateway Service.',
  },
];

export const TargetSelector: React.FC<Props> = ({ onSelect }) => (
  <div className="max-w-3xl mx-auto space-y-4">
    <h1 className="text-xl font-semibold text-center text-gray-100">Where will this run?</h1>
    <p className="text-sm text-gray-400 text-center">Pick where your OpenTelemetry gateway will live. You can change this later.</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {CARDS.map(c => (
        <button
          key={c.target}
          onClick={() => onSelect(c.target)}
          className="text-left adapt-card hover:border-primary/60 transition-colors group"
        >
          <div className="flex items-center gap-3 mb-2 text-link group-hover:text-primary">
            {c.icon}
            <span className="text-lg font-semibold text-gray-100">{c.title}</span>
          </div>
          <p className="text-sm text-gray-300 mb-1">{c.tagline}</p>
          <p className="text-tiny text-gray-500">{c.detail}</p>
        </button>
      ))}
    </div>
    <div className="flex items-center justify-center pt-2">
      <a href="/step-zero" className="text-tiny text-gray-400 hover:text-gray-200 underline">No collector or instrumented apps yet? Start from zero →</a>
    </div>
  </div>
);
```

- [ ] **Step 2: Build to verify**

Run: `npm --prefix frontend run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/wizard/TargetSelector.tsx
git commit -m "feat(k8s): target selector screen (Docker / Kubernetes card grid)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire the branch into `App.tsx` + `Stepper` + `Step1`

**Files:**
- Modify: `frontend/src/components/wizard/Stepper.tsx`
- Modify: `frontend/src/components/wizard/Step1.tsx`
- Modify: `frontend/src/App.tsx`

> The integration: `Stepper` takes per-target `steps`; `Step1` takes a target-aware `primaryLabel`; `App` adds `target` state, the selector gate, the forked step renders, the Step-1 K8s commit branch, Docker-effect gating, the re-choose chip, and target-clearing on reset.

- [ ] **Step 1: Replace `frontend/src/components/wizard/Stepper.tsx` to take a `steps` prop**

```tsx
import React from 'react';
import { Check } from 'lucide-react';

type WizardStep = { n: number; label: string };

type Props = {
  current: number;
  steps: WizardStep[];
  onJump: (step: number) => void;
};

export const Stepper: React.FC<Props> = ({ current, steps, onJump }) => (
  <div className="flex items-center justify-between gap-2 px-1">
    {steps.map((s, idx) => {
      const isCurrent = current === s.n;
      const isCompleted = current > s.n;
      const clickable = s.n <= current;
      return (
        <React.Fragment key={s.n}>
          <button
            onClick={() => clickable && onJump(s.n)}
            disabled={!clickable}
            className={`flex items-center gap-2 ${clickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span
              className={`w-7 h-7 rounded inline-flex items-center justify-center text-tiny font-semibold border ${
                isCurrent
                  ? 'bg-primary border-primary text-white'
                  : isCompleted
                    ? 'bg-success border-success text-white'
                    : 'bg-gray-1000 border-gray-700 text-gray-400'
              }`}
            >
              {isCompleted ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : s.n}
            </span>
            <span className={`text-tiny font-semibold uppercase tracking-wider ${isCurrent ? 'text-gray-100' : isCompleted ? 'text-gray-300' : 'text-gray-500'}`}>
              {s.label}
            </span>
          </button>
          {idx < steps.length - 1 && (
            <span className={`flex-1 h-px ${current > s.n ? 'bg-success/60' : 'bg-gray-800'}`} />
          )}
        </React.Fragment>
      );
    })}
  </div>
);
```

- [ ] **Step 2: In `frontend/src/components/wizard/Step1.tsx`, add a `primaryLabel` prop**

In the `Props` type (after `testingConnection: boolean;`), add:
```tsx
  primaryLabel?: string;
```
In the destructured props (after `testingConnection,`), add:
```tsx
  primaryLabel = 'Save & initialize →',
```
Replace the primary button's label expression `{isVerifying ? 'Saving…' : 'Save & initialize →'}` with:
```tsx
        {isVerifying ? 'Saving…' : primaryLabel}
```

- [ ] **Step 3: In `App.tsx`, add the imports**

After the existing `import { Step5 } from './components/wizard/Step5';` line, add:
```tsx
import { Step2K8s } from './components/wizard/Step2K8s';
import { Step3K8s } from './components/wizard/Step3K8s';
import { Step4K8s } from './components/wizard/Step4K8s';
import { TargetSelector } from './components/wizard/TargetSelector';
import { getWizardSteps, isWizardTargetOrNull, type WizardTarget } from './components/wizard/wizardTargets';
```

- [ ] **Step 4: In `App.tsx`, add the `target` state**

Immediately after the `setupStep` `useLocalStorageState` declaration (the block ending `) >= 1 && v <= 5,\n  );`), add:
```tsx
  // Onboarding target: Docker (manage a local gateway container) vs Kubernetes
  // (generate a Helm chart). Chosen on the selector screen; null forces the
  // selector. localStorage like setupStep — a flow choice, not a credential.
  const [target, setTarget] = useLocalStorageState<WizardTarget | null>(
    'helix-configurator.target',
    null,
    isWizardTargetOrNull,
  );
```

- [ ] **Step 5: In `App.tsx` `handleInitialize`, branch the Kubernetes commit**

At the very top of the `try {` block inside `handleInitialize` (right after `setSetupError('');` and before the `// Save keys` comment), insert:
```tsx
      // Kubernetes target: just persist the creds (POST /api/env reloads
      // process.env so the Step-2 chart preview bakes them in) and advance.
      // No gateway container to recreate, no Docker network diagnostic.
      if (target === 'kubernetes') {
        const envRes = await fetch('/api/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envVars),
        });
        if (!envRes.ok) throw new Error('Failed to save settings');
        setSetupStep(2);
        return; // the finally block clears isVerifying
      }
```

- [ ] **Step 6: In `App.tsx`, gate the Docker-only wizard effects to `target === 'docker'`**

Add `&& target === 'docker'` to the two wizard effects that depend on the Docker socket / local gateway. They must not run on the Kubernetes branch (they would poll the local configurator gateway and show misleading zeros).

In the receiver-counter poll effect, change the guard line:
```tsx
    if (isSetupComplete || setupStep !== 4) {
```
to:
```tsx
    if (isSetupComplete || setupStep !== 4 || target !== 'docker') {
```

In the detected-collectors refresh effect, change the guard line:
```tsx
    if (isSetupComplete || (setupStep !== 2 && setupStep !== 3)) return;
```
to:
```tsx
    if (isSetupComplete || (setupStep !== 2 && setupStep !== 3) || target !== 'docker') return;
```

Add `target` to **both** effects' dependency arrays (append `, target` inside the `[...]` deps — for the receiver effect `[setupStep, isSetupComplete]` → `[setupStep, isSetupComplete, target]`; for the collectors effect `[setupStep, isSetupComplete]` → `[setupStep, isSetupComplete, target]`).

- [ ] **Step 7: In `App.tsx` `requestResetOnboarding`, clear the target on reset**

Inside the reset `onConfirm`, alongside the other state resets (near `setSetupStep(1);`), add:
```tsx
        setTarget(null);
```

- [ ] **Step 8: In `App.tsx`, render the selector gate, the chip, the per-target Stepper, and the forked steps**

Replace the wizard container — the block that currently is:
```tsx
          {!isSetupComplete ? (
            <div className="max-w-5xl mx-auto space-y-4">
              <h1 className="text-xl font-semibold text-center text-gray-100">Welcome to Helix Configurator</h1>

              <Stepper current={setupStep} onJump={setSetupStep} />
```
with (note the new `!target` gate, the chip, and the `steps` prop):
```tsx
          {!isSetupComplete ? (
            !target ? (
              <TargetSelector onSelect={(t) => setTarget(t)} />
            ) : (
            <div className="max-w-5xl mx-auto space-y-4">
              <h1 className="text-xl font-semibold text-center text-gray-100">Welcome to Helix Configurator</h1>

              {/* Re-choose target. Resets to Step 1 — steps 2/3 differ by target,
                  so restarting the branch is correct. Creds stay in .env. */}
              <div className="flex justify-center">
                <button
                  onClick={() => { setTarget(null); setSetupStep(1); }}
                  className="text-tiny text-gray-400 hover:text-gray-200 border border-gray-800 rounded px-2 py-1"
                  title="Switch between Docker and Kubernetes"
                >
                  Target: {target === 'kubernetes' ? 'Kubernetes' : 'Docker'} · change
                </button>
              </div>

              <Stepper current={setupStep} steps={getWizardSteps(target)} onJump={setSetupStep} />
```

Then update the `Step1` render to pass the target-aware label — change:
```tsx
                <Step1
                  envVars={envVars}
```
to:
```tsx
                <Step1
                  primaryLabel={target === 'kubernetes' ? 'Save & continue →' : 'Save & initialize →'}
                  envVars={envVars}
```

Then replace the Step 2/3/4 renders. Change the `{setupStep === 2 && (` … `)}`, `{setupStep === 3 && (` … `)}`, and `{setupStep === 4 && (` … `)}` blocks so each forks on target. Wrap the **existing** `<Step2 … />`, `<Step3 … />`, `<Step4 … />` JSX as the Docker branch:
```tsx
              {setupStep === 2 && (target === 'kubernetes' ? (
                <Step2K8s onBack={() => setSetupStep(1)} onNext={() => setSetupStep(3)} />
              ) : (
                <Step2
                  smartAddProposal={smartAdd.proposal}
                  smartAddResult={smartAdd.result}
                  smartAddLoading={smartAdd.loading}
                  onOpenSmartAddPreview={() => smartAdd.setPreviewOpen(true)}
                  onOpenGatewayConfig={openGatewayConfigModal}
                  onDismissResult={smartAdd.dismissResult}
                  onVerifyExporter={smartAdd.proposal ? () => smartAdd.refresh(smartAdd.proposal!.name) : null}
                  onBack={() => setSetupStep(1)}
                  onNext={() => setSetupStep(3)}
                />
              ))}

              {setupStep === 3 && (target === 'kubernetes' ? (
                <Step3K8s onBack={() => setSetupStep(2)} onNext={() => setSetupStep(4)} />
              ) : (
                <Step3
                  bridgeStatus={bridgeStatus}
                  tab={step3Tab}
                  setTab={setStep3Tab}
                  detectedCollectors={detectedCollectors}
                  attachingNetwork={attachingNetwork}
                  attachResult={attachResult}
                  onAttachNetwork={attachSidecarToNetwork}
                  onDetachNetwork={detachSidecarFromNetwork}
                  detachingNetwork={detachingNetwork}
                  k8sApplying={k8sApplying}
                  k8sApplyResult={k8sApplyResult}
                  onApplyK8sTemplate={requestApplyK8sTemplate}
                  onBack={() => setSetupStep(2)}
                  onNext={() => setSetupStep(4)}
                  onJumpToStep={setSetupStep}
                />
              ))}

              {setupStep === 4 && (target === 'kubernetes' ? (
                <Step4K8s
                  otelDashboardUrl={externalApps.otelDashboardUrl}
                  onBack={() => setSetupStep(3)}
                  onFinishStep={() => setSetupStep(5)}
                />
              ) : (
                <Step4
                  bridgeStatus={bridgeStatus}
                  detectedCollectors={detectedCollectors}
                  receiverNow={receiverNow}
                  receiverBaseline={receiverBaseline}
                  receiverError={receiverError}
                  appExportErrors={appExportErrors}
                  gatewayStatus={gatewayStatus}
                  restartingGateway={restartingGateway}
                  onRestartGateway={handleRestartGateway}
                  onJumpToStep={setSetupStep}
                  onLaunchDashboard={() => setSetupStep(5)}
                />
              ))}
```

(The `setupStep === 1` and `setupStep === 5` renders, the reset row, and the `GatewayConfigModal`/`SmartAddPreviewModal` siblings stay as they are — they're inside this same container.)

- [ ] **Step 9: Close the new `!target` ternary**

The wizard container `<div className="max-w-5xl mx-auto space-y-4"> … </div>` is now the `: (` branch of the `!target` ternary opened in Step 8. Find that container's matching closing `</div>` (the one immediately before the `) : (` that begins the dashboard branch — i.e., right before the line `          ) : (` that precedes `<PipelineStatusBanner`). Add a closing `)` after it so the ternary is balanced:
```tsx
            </div>
            )
          ) : (
```

- [ ] **Step 10: Build to verify the integration typechecks**

Run: `npm --prefix frontend run build`
Expected: build succeeds. If a JSX-balance error appears, recheck Step 9's added `)`. If `Stepper`'s old `STEPS` is reported unused anywhere, it was removed in Step 1 — ignore.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/wizard/Stepper.tsx frontend/src/components/wizard/Step1.tsx frontend/src/App.tsx
git commit -m "feat(k8s): branch onboarding by target (selector + forked steps)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: README note, full verification, mark spec implemented

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-04-k8s-onboarding-branch-design.md` (status line)

- [ ] **Step 1: Add a short README note**

In `README.md`, find the existing `## Generate a Kubernetes chart` section and insert this paragraph immediately under its heading (before the existing content):
```markdown
Onboarding is **target-branched**: the wizard opens with a **"Where will this run?"** choice
(Docker / Kubernetes). The Kubernetes path generates this chart as a first-class step, then guides you
to point apps at the gateway Service and verify. The dashboard action below is the same generator, for
re-running after onboarding.

```

- [ ] **Step 2: Run the full frontend suite (tests + build)**

Run: `CI=true npm --prefix frontend test -- --run && npm --prefix frontend run build`
Expected: all frontend tests pass (the existing suite + the new `wizardTargets` tests) and the build succeeds.

- [ ] **Step 3: Run the backend suite (regression — no backend changes)**

Run: `npm --prefix backend test`
Expected: green — this round touches no backend, so the Phase 1 k8s-routes/env/other suites must be unchanged.

- [ ] **Step 4: Manual smoke (optional, if a dev server is handy)**

Start the app, then in the wizard: the selector shows first → pick **Kubernetes** → Step 1 saves creds and advances without a container recreate → Step 2 previews + downloads the chart → Step 3 shows the Service-DNS snippet (edit the namespace field, watch the endpoint update) → Step 4 shows the kubectl guidance + Helix deep-link → Step 5 links the service. Then use the chip to switch to **Docker** and confirm the existing flow is unchanged.

- [ ] **Step 5: Mark the spec implemented**

In `docs/superpowers/specs/2026-06-04-k8s-onboarding-branch-design.md`, change the header
`Status: **Draft for review**` → `Status: **Implemented** (feat/k8s-onboarding-branch)`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/superpowers/specs/2026-06-04-k8s-onboarding-branch-design.md
git commit -m "docs(k8s): note the branched onboarding + mark spec implemented" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:** target model + state (spec §4 → Task 1, Task 6 Steps 4,7) · selector screen (§5 → Task 5, Task 6 Step 8) · per-target stepper (§6 → Task 1, Task 6 Step 1) · Step 1 shared form / forked commit (§7 → Task 6 Steps 2,5) · Step 2 forks incl. `K8sChartPanel` reuse (§7, §9 → Tasks 2,4) · Step 3 point-apps + Service DNS + `NamespaceRecipe` (§7, §9 → Tasks 1,3,4) · Step 4 verify guidance + Helix deep-link (§7 → Task 4) · Step 5 shared/unchanged (§7 → no change needed) · Docker-effect gating (§8 → Task 6 Step 6) · backend reuse, zero changes (§10 → verified, Task 7 Step 3) · dashboard re-entry via shared panel (§9 → Task 2) · testing (§12 → Tasks 1,7) · README (§13 → Task 7). Deferred items (live verify, Operator, OpenShift, bare-metal — §14) are intentionally not built.

**Placeholder scan:** none — every step has full code or exact edit instructions + commands. No React component-test harness exists in this repo (confirmed in the Phase 1 plan), so component verification is the TypeScript build + the pure-`wizardTargets` tests + the manual smoke, exactly as Phase 1 did.

**Type/name consistency:** `WizardTarget = 'docker' | 'kubernetes'`, `getWizardSteps(target)`, `k8sGatewayEndpoint(namespace='default')`, `isWizardTargetOrNull` (localStorage validator) — all defined in Task 1 and used identically in Tasks 4–6. Step components' prop shapes: `Step2K8s {onBack,onNext}`, `Step3K8s {onBack,onNext}`, `Step4K8s {otelDashboardUrl,onBack,onFinishStep}`, `TargetSelector {onSelect}`, `Stepper {current,steps,onJump}`, `Step1 {…,primaryLabel?}`, `NamespaceRecipe {extraNote?}` — consistent between their Create task and their `App.tsx` render. The shared Service name `helix-gateway` and chart label `app.kubernetes.io/part-of=helix-otel` match the Phase 1 chart. `externalApps.otelDashboardUrl` is already defined in `App.tsx` before the wizard render, so it's in scope for the Step 4 K8s prop.
