# Link OTel namespace → Business Service — Frontend Plan (GUIDED-ONLY v1, Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the guided "link OTel namespace → Business Service" UI — a shared `LinkBusinessService` flow surfaced as wizard **Step 5** and a **dashboard card** — consuming the Plan 1 backend (`/api/business-service/{namespaces,bind-instructions,persist-key}`), on `feat/link-business-service`.

**Architecture:** One hook (`useBusinessServiceLink`) + one presentational component (`LinkBusinessService`, a 4-phase flow: Detect → Guide → Capture → Done) with a `context: 'wizard' | 'dashboard'` prop. Thin wrappers (`Step5`, `BusinessServiceCard`) place it. No new auth/network beyond the three backend routes.

**Tech Stack:** React 18 + TypeScript + Tailwind (the `adapt-*` design-system classes), Vite, lucide-react icons.

> **Backend (Plan 1) is done + green** on this branch: `GET /api/business-service/namespaces` → `{ namespaces: [{ namespace, traceCount, lastSeen, fallback }] }`; `GET /api/business-service/bind-instructions?namespace=` → `{ namespace, steps[], aiopsUrl, dashboardUrl }`; `POST /api/business-service/persist-key` `{ key }` → `{ ok, businessServiceKey }` (tolerates a pasted AIOps URL; writes `.env` + `process.env`).
>
> **Testing convention (deliberate):** the frontend has NO component/hook test infra (vitest `node` env, `*.test.ts` only, no jsdom/testing-library) and no component is unit-tested today. We MATCH that — do NOT add jsdom/testing-library. Verification per task = `cd frontend && npm run build` (tsc must pass) and `cd backend && npm test` staying green. Extract pure logic into a `.ts` helper with a `*.test.ts` ONLY if it carries real branching worth pinning. UI correctness is verified by build + manual smoke.
>
> **`docs/` is gitignored** — `git add` only the `frontend/**` files named in each task.

---

## File Structure

| File | New? | Responsibility |
|---|---|---|
| `frontend/src/hooks/useBusinessServiceLink.ts` | Create | Fetches the 3 endpoints; holds namespaces/instructions/saving/savedKey/error + actions. |
| `frontend/src/components/business-service/LinkBusinessService.tsx` | Create | The 4-phase guided flow UI; `context: 'wizard' \| 'dashboard'`. |
| `frontend/src/components/wizard/Step5.tsx` | Create | Wizard wrapper: `adapt-card` + heading + `<LinkBusinessService context="wizard"/>` + Back/Finish nav. |
| `frontend/src/components/wizard/Stepper.tsx` | Modify | Add `{ n: 5, label: 'Link Service' }` to `STEPS`. |
| `frontend/src/components/dashboard/BusinessServiceCard.tsx` | Create | Dashboard wrapper: `<LinkBusinessService context="dashboard"/>`. |
| `frontend/src/App.tsx` | Modify | Bump step validator to 5; import + render Step 5; repoint Step 4's terminal CTA; render the dashboard card. |

---

## Task 1: `useBusinessServiceLink` hook

**Files:** Create `frontend/src/hooks/useBusinessServiceLink.ts`

- [ ] **Step 1: Implement the hook** (complete code; mirrors `useSmartAdd`'s fetch/error/`finally` pattern):

```tsx
import { useState, useCallback } from 'react';

export type NamespaceRow = { namespace: string; traceCount: number; lastSeen: number; fallback: boolean };
export type BindInstructions = { namespace: string; steps: string[]; aiopsUrl: string; dashboardUrl: string };

export type UseBusinessServiceLink = {
  namespaces: NamespaceRow[];
  loadingNamespaces: boolean;
  instructions: BindInstructions | null;
  loadingInstructions: boolean;
  saving: boolean;
  savedKey: string | null;
  error: string;
  loadNamespaces: () => Promise<void>;
  loadInstructions: (namespace: string) => Promise<void>;
  persistKey: (input: string) => Promise<boolean>;
  reset: () => void;
};

export function useBusinessServiceLink(): UseBusinessServiceLink {
  const [namespaces, setNamespaces] = useState<NamespaceRow[]>([]);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [instructions, setInstructions] = useState<BindInstructions | null>(null);
  const [loadingInstructions, setLoadingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadNamespaces = useCallback(async () => {
    setLoadingNamespaces(true); setError('');
    try {
      const res = await fetch('/api/business-service/namespaces');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load namespaces'); return; }
      setNamespaces(Array.isArray(data.namespaces) ? data.namespaces : []);
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoadingNamespaces(false); }
  }, []);

  const loadInstructions = useCallback(async (namespace: string) => {
    setLoadingInstructions(true); setError('');
    try {
      const res = await fetch(`/api/business-service/bind-instructions?namespace=${encodeURIComponent(namespace)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load instructions'); return; }
      setInstructions(data as BindInstructions);
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoadingInstructions(false); }
  }, []);

  const persistKey = useCallback(async (input: string): Promise<boolean> => {
    if (saving) return false;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/business-service/persist-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not save key'); return false; }
      setSavedKey(data.businessServiceKey || '');
      return true;
    } catch (e: any) { setError(e?.message || 'Network error'); return false; }
    finally { setSaving(false); }
  }, [saving]);

  const reset = useCallback(() => { setInstructions(null); setSavedKey(null); setError(''); }, []);

  return { namespaces, loadingNamespaces, instructions, loadingInstructions, saving, savedKey, error, loadNamespaces, loadInstructions, persistKey, reset };
}
```

- [ ] **Step 2: Verify it compiles:** `cd frontend && npm run build` → tsc passes (no type errors).
- [ ] **Step 3: Commit:** `git add frontend/src/hooks/useBusinessServiceLink.ts && git commit -m "feat(business-service): useBusinessServiceLink hook"`

---

## Task 2: `LinkBusinessService` component (4-phase flow)

**Files:** Create `frontend/src/components/business-service/LinkBusinessService.tsx`

The phases are local state: `detect` (pick an arriving namespace) → `guide` (checklist + AIOps link + paste-back) → `done` (key captured + dashboard link). "Capture" is the paste-back action inside `guide`. Use the documented design-system classes: card `adapt-card`; section label `text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3`; primary button `bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-semibold transition-all flex items-center gap-2`; secondary `bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-2 rounded font-semibold text-sm`; input `adapt-input`; inner cell `bg-gray-1000 border border-gray-800 rounded p-3`. Follow `Step4.tsx`/`QuickActions.tsx` for tone. Match existing lucide-react icon usage.

- [ ] **Step 1: Implement the component** (starting implementation — refine styling to match `Step4`/`QuickActions`, but keep the props, state machine, hook usage, and the data flow exactly as below):

```tsx
import React, { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, CheckCircle2, Loader2, Boxes, AlertTriangle } from 'lucide-react';
import { useBusinessServiceLink, type NamespaceRow } from '../../hooks/useBusinessServiceLink';

type Props = {
  context: 'wizard' | 'dashboard';
  /** Current captured key (from env), shown as "already linked" context. */
  currentKey?: string;
  /** Called after a key is successfully captured (e.g. to refresh env in the parent). */
  onCaptured?: (key: string) => void;
  /** Optional toast callback (dashboard passes App's showToastMsg). */
  onToast?: (message: string, type?: 'success' | 'error') => void;
};

export const LinkBusinessService: React.FC<Props> = ({ context, currentKey, onCaptured, onToast }) => {
  const bs = useBusinessServiceLink();
  const [phase, setPhase] = useState<'detect' | 'guide' | 'done'>('detect');
  const [selectedNs, setSelectedNs] = useState('');
  const [paste, setPaste] = useState('');

  useEffect(() => { bs.loadNamespaces(); /* on mount */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (ns: string) => {
    setSelectedNs(ns);
    await bs.loadInstructions(ns);
    setPhase('guide');
  };

  const capture = async () => {
    const ok = await bs.persistKey(paste);
    if (ok) {
      setPhase('done');
      onToast?.('Business Service key captured', 'success');
      onCaptured?.(paste);
    } else {
      onToast?.(bs.error || 'Could not save key', 'error');
    }
  };

  // --- Detect -------------------------------------------------------------
  if (phase === 'detect') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          Link each OpenTelemetry namespace arriving from your gateway to a Business Service in AIOps,
          so topology, health, and Situations roll up to it.
        </p>
        {bs.loadingNamespaces && <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Detecting namespaces…</div>}
        {!bs.loadingNamespaces && bs.namespaces.length === 0 && (
          <div className="bg-gray-1000 border border-gray-800 rounded p-3 text-sm text-gray-300">
            No telemetry arriving yet. Start your app or run a synthetic scenario from{' '}
            <a href="/step-zero" className="text-link hover:underline">Start from zero</a>, then come back.
          </div>
        )}
        {bs.namespaces.map((n: NamespaceRow) => (
          <div key={n.namespace} className="bg-gray-1000 border border-gray-800 rounded p-3 flex items-center gap-3">
            <Boxes className="w-4 h-4 text-blue-300 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-100 font-medium truncate">{n.namespace}{n.fallback && <span className="ml-2 text-tiny text-gray-500">(via X-Source)</span>}</div>
              <div className="text-tiny text-gray-500">{n.traceCount} trace{n.traceCount === 1 ? '' : 's'} seen</div>
            </div>
            <button onClick={() => pick(n.namespace)} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-3 py-1.5 rounded font-semibold text-sm flex items-center gap-1.5">
              Link <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {bs.error && <div className="flex items-center gap-2 text-sm text-[#ff8a8a]"><AlertTriangle className="w-4 h-4" /> {bs.error}</div>}
      </div>
    );
  }

  // --- Guide + Capture ----------------------------------------------------
  if (phase === 'guide') {
    const ins = bs.instructions;
    return (
      <div className="space-y-3">
        <button onClick={() => { setPhase('detect'); bs.reset(); }} className="text-tiny text-gray-400 hover:text-gray-200 underline">← Pick a different namespace</button>
        <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Link “{selectedNs}” in AIOps</div>
        {bs.loadingInstructions && <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
        {ins && (
          <>
            <ol className="list-decimal ml-5 space-y-1.5 text-sm text-gray-300">
              {ins.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {ins.aiopsUrl && (
              <a href={ins.aiopsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-link hover:underline">
                Open BMC Helix AIOps <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <div className="bg-gray-1000 border border-gray-800 rounded p-3 space-y-2">
              <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Paste the Business Service URL (or key)</label>
              <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://…/aiops/#/entities/service/…?type=key" className="adapt-input" />
              <button onClick={capture} disabled={!paste.trim() || bs.saving} className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-semibold transition-all flex items-center gap-2">
                {bs.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Capture key
              </button>
            </div>
          </>
        )}
        {bs.error && <div className="flex items-center gap-2 text-sm text-[#ff8a8a]"><AlertTriangle className="w-4 h-4" /> {bs.error}</div>}
      </div>
    );
  }

  // --- Done ---------------------------------------------------------------
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="w-5 h-5" /> Linked — key captured for “{selectedNs}”.</div>
      <p className="text-sm text-gray-400">Your AIOps deep-links now resolve to this Business Service. Confirm the rollup:</p>
      {bs.instructions?.dashboardUrl && (
        <a href={bs.instructions.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-link hover:underline">
          Open the namespace dashboard <ExternalLink className="w-4 h-4" />
        </a>
      )}
      <div><button onClick={() => { setPhase('detect'); setPaste(''); setSelectedNs(''); bs.reset(); bs.loadNamespaces(); }} className="text-tiny text-gray-400 hover:text-gray-200 underline">Link another namespace</button></div>
    </div>
  );
};
```

- [ ] **Step 2: Verify build:** `cd frontend && npm run build` → tsc passes.
- [ ] **Step 3: Commit:** `git add frontend/src/components/business-service/LinkBusinessService.tsx && git commit -m "feat(business-service): LinkBusinessService 4-phase guided flow"`

---

## Task 3: Wizard Step 5 integration

**Files:** Create `frontend/src/components/wizard/Step5.tsx`; modify `frontend/src/components/wizard/Stepper.tsx`, `frontend/src/components/wizard/Step4.tsx`, `frontend/src/App.tsx`.

- [ ] **Step 1: Create `Step5.tsx`:**

```tsx
import React from 'react';
import { ArrowLeft, LayoutDashboard } from 'lucide-react';
import { LinkBusinessService } from '../business-service/LinkBusinessService';

type Props = {
  onBack: () => void;
  onFinish: () => void;
  currentKey?: string;
  onCaptured?: (key: string) => void;
};

export const Step5: React.FC<Props> = ({ onBack, onFinish, currentKey, onCaptured }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 5: Link to a Business Service</h2>
    <p className="text-sm text-gray-400 mb-4">
      Optional but recommended — associate your telemetry with a Business Service so AIOps rolls up health and Situations. You can also do this later from the dashboard.
    </p>
    <LinkBusinessService context="wizard" currentKey={currentKey} onCaptured={onCaptured} />
    <div className="flex items-center justify-between mt-5">
      <button onClick={onBack} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-2 rounded font-semibold text-sm flex items-center gap-2">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <button onClick={onFinish} className="bg-primary hover:bg-[#3006c2] text-white px-4 py-2 rounded font-semibold text-sm flex items-center gap-2">
        <LayoutDashboard className="w-4 h-4" /> Finish & open dashboard
      </button>
    </div>
  </div>
);
```

- [ ] **Step 2: Add Step 5 to `Stepper.tsx`** — change the `STEPS` array to include the 5th entry:
```tsx
const STEPS = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Exporter' },
  { n: 3, label: 'Connect' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];
```

- [ ] **Step 3: Bump the step validator in `App.tsx`** — the `useLocalStorageState<number>('helix-configurator.setupStep', 1, ...)` guard currently ends `... && v >= 1 && v <= 4`. Change `v <= 4` to `v <= 5`.

- [ ] **Step 4: Repoint Step 4's terminal action to advance to Step 5.** In `App.tsx`, the `<Step4 .../>` block currently passes `onLaunchDashboard={() => { localStorage.setItem('helix-configurator.onboarded','1'); localStorage.removeItem('helix-configurator.setupStep'); setIsSetupComplete(true); /* clean URL */ }}`. Do this refactor:
  1. Extract that exact body into a named handler near the other handlers: `const finishOnboarding = () => { localStorage.setItem('helix-configurator.onboarded', '1'); localStorage.removeItem('helix-configurator.setupStep'); setIsSetupComplete(true); if (window.location.pathname !== '/' || window.location.search) { window.history.replaceState(null, '', '/'); } };`
  2. Change the Step 4 prop to advance instead of finish: `onLaunchDashboard={() => setSetupStep(5)}`.
  3. In `Step4.tsx`, find the terminal button that calls `onLaunchDashboard` (its label is "Launch Dashboard"/similar) and relabel it to **"Next: Link your service"** with a right-arrow icon (e.g. `ArrowRight`), keeping the same `onClick={onLaunchDashboard}`. (Do not rename the prop — minimal change.)

- [ ] **Step 5: Render Step 5 in `App.tsx`** — add the import `import { Step5 } from './components/wizard/Step5';` alongside the other wizard imports, and add this block immediately after the `{setupStep === 4 && (<Step4 .../>)}` block:
```tsx
{setupStep === 5 && (
  <Step5
    onBack={() => setSetupStep(4)}
    onFinish={finishOnboarding}
    currentKey={envVars.BUSINESS_SERVICE_KEY}
    onCaptured={(key) => setEnvVars((prev) => ({ ...prev, BUSINESS_SERVICE_KEY: key }))}
  />
)}
```
(If `setEnvVars` takes a full object rather than an updater, match its existing call style — read how `setEnvVars` is used elsewhere in `App.tsx` and mirror it.)

- [ ] **Step 6: Verify build:** `cd frontend && npm run build` → tsc passes. Manually sanity-check: the Stepper shows 5 steps; Step 4's button advances to Step 5; Step 5 Back→4 and Finish→dashboard.

- [ ] **Step 7: Commit:** `git add frontend/src/components/wizard/Step5.tsx frontend/src/components/wizard/Stepper.tsx frontend/src/components/wizard/Step4.tsx frontend/src/App.tsx && git commit -m "feat(business-service): wizard Step 5 (Link to Business Service)"`

---

## Task 4: Dashboard card

**Files:** Create `frontend/src/components/dashboard/BusinessServiceCard.tsx`; modify `frontend/src/App.tsx`.

- [ ] **Step 1: Create `BusinessServiceCard.tsx`:**

```tsx
import React from 'react';
import { LinkBusinessService } from '../business-service/LinkBusinessService';

type Props = {
  currentKey?: string;
  onCaptured?: (key: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
};

export const BusinessServiceCard: React.FC<Props> = ({ currentKey, onCaptured, onToast }) => (
  <div className="adapt-card">
    <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">Business Service</div>
    <LinkBusinessService context="dashboard" currentKey={currentKey} onCaptured={onCaptured} onToast={onToast} />
  </div>
);
```

- [ ] **Step 2: Render it in the dashboard** — in `App.tsx`, in the `isSetupComplete` branch, add `<BusinessServiceCard .../>` right after the `<QuickActions .../>` block:
```tsx
<BusinessServiceCard
  currentKey={envVars.BUSINESS_SERVICE_KEY}
  onCaptured={(key) => setEnvVars((prev) => ({ ...prev, BUSINESS_SERVICE_KEY: key }))}
  onToast={showToastMsg}
/>
```
Add the import `import { BusinessServiceCard } from './components/dashboard/BusinessServiceCard';`. (Match the existing `setEnvVars` call style if it isn't an updater fn.)

- [ ] **Step 3: Verify build:** `cd frontend && npm run build` → tsc passes.
- [ ] **Step 4: Commit:** `git add frontend/src/components/dashboard/BusinessServiceCard.tsx frontend/src/App.tsx && git commit -m "feat(business-service): dashboard Business Service card"`

---

## Task 5: Whole-feature verification

**Files:** none (verification + a smoke checklist).

- [ ] **Step 1: Build clean:** `cd frontend && npm run build` → succeeds, zero TS errors.
- [ ] **Step 2: Backend still green:** `cd backend && npm test` → full suite passes (no regressions from anything).
- [ ] **Step 3: Manual smoke (document results; do not auto-merge):** with the app running (`docker-compose up` or the dev servers), confirm: (a) wizard shows 5 steps; (b) Step 4 advances to Step 5; (c) Step 5 lists arriving namespaces (or the empty-state with the Step-0 link when none); (d) picking one shows the AIOps checklist + "Open AIOps" link + paste box; (e) pasting an AIOps service URL + "Capture key" shows the Done state and the namespace-dashboard link; (f) the dashboard shows the Business Service card behaving the same; (g) after capture, `/api/env` reports the new `BUSINESS_SERVICE_KEY` and the existing AIOps deep-links light up.
- [ ] **Step 4: Report** the build + test results and the smoke findings. Do NOT push or merge — leave it on `feat/link-business-service` for the user to review.

---

## Self-Review

**1. Spec coverage:** Detect (Task 2 detect phase + hook `loadNamespaces`), Guide (Task 2 guide phase + `loadInstructions`), Capture (Task 2 capture + hook `persistKey`), Confirm/Done (Task 2 done phase + `dashboardUrl`), wizard placement (Task 3), dashboard placement (Task 4), whole-feature verification (Task 5). All spec elements covered.

**2. Placeholder scan:** none — complete code for the hook, component, and both wrappers; integration edits are exact (with one explicit "match existing `setEnvVars` style" instruction where the call shape must be confirmed in-file).

**3. Type/name consistency:** `NamespaceRow`/`BindInstructions` defined in the hook and consumed by the component; `UseBusinessServiceLink` action names (`loadNamespaces`, `loadInstructions`, `persistKey`, `reset`) match between hook and component; `LinkBusinessService` props (`context`, `currentKey`, `onCaptured`, `onToast`) match its call sites in `Step5` and `BusinessServiceCard`; backend response shapes (`{ namespaces }`, `{ steps, aiopsUrl, dashboardUrl }`, `{ businessServiceKey }`) match Plan 1.

---

## Execution Handoff

Tasks are ordered by dependency (1 → 2 → 3/4 → 5). Task 3 touches `App.tsx`/`Step4.tsx` and Task 4 also touches `App.tsx`, so run them sequentially (never parallel) to avoid edit conflicts. Subagent-driven; `npm run build` is the per-task gate (no component-test infra by design). After Task 5, the whole feature lives on `feat/link-business-service` for user review — then `superpowers:finishing-a-development-branch`.
