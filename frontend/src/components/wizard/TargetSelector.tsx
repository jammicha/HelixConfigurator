import React, { useState } from 'react';
import { ArrowLeft, Boxes, Container, Ship, Wrench } from 'lucide-react';
import type { WizardTarget } from './wizardTargets';

type Props = { onSelect: (t: WizardTarget) => void };

// The selector asks up to two quick questions: 1 — which platform, and (only
// for Kubernetes) 2 — how apps get instrumented (manual Helm chart vs the
// OTel Operator). The instrument choice is a Kubernetes sub-decision, not a
// third platform: presenting it as a sibling card forced brand-new users to
// understand the Operator tradeoff before anything else. Docker has no second
// question — picking it enters the wizard immediately. Future platforms
// (bare-metal / systemd) slot in as new stage-1 cards without restructuring
// the wizard.
type Stage = 'platform' | 'k8s-instrument';

const STEPS: Array<{ n: number; label: string; stage: Stage }> = [
  { n: 1, label: 'Platform', stage: 'platform' },
  { n: 2, label: 'Instrumentation', stage: 'k8s-instrument' },
];

const CardButton: React.FC<{
  icon: React.ReactNode; title: string; tagline: string; detail: string; onClick: () => void;
}> = ({ icon, title, tagline, detail, onClick }) => (
  <button onClick={onClick} className="text-left adapt-card hover:border-primary/60 transition-colors group">
    <div className="flex items-center gap-3 mb-2 text-link group-hover:text-primary">
      {icon}
      <span className="text-lg font-semibold text-gray-100">{title}</span>
    </div>
    <p className="text-sm text-gray-300 mb-1">{tagline}</p>
    <p className="text-tiny text-gray-500">{detail}</p>
  </button>
);

export const TargetSelector: React.FC<Props> = ({ onSelect }) => {
  const [stage, setStage] = useState<Stage>('platform');
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-center gap-2 pb-1">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.n}>
            {i > 0 && <div className="w-10 h-px bg-gray-700" />}
            <div className="flex items-center gap-2">
              <span className={`w-5 h-5 rounded-full text-tiny font-semibold flex items-center justify-center ${s.stage === stage ? 'bg-primary text-white' : 'bg-gray-800 text-gray-500 border border-gray-700'}`}>{s.n}</span>
              <span className={`text-tiny uppercase tracking-wider ${s.stage === stage ? 'text-gray-200' : 'text-gray-500'}`}>{s.label}</span>
            </div>
          </React.Fragment>
        ))}
      </div>

      {stage === 'platform' ? (
        <>
          <h1 className="text-xl font-semibold text-center text-gray-100">Where will this run?</h1>
          <p className="text-sm text-gray-400 text-center">Pick where your OpenTelemetry gateway will live. You can change this later.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CardButton
              icon={<Container className="w-6 h-6" />}
              title="Docker Desktop / Compose"
              tagline="Run the gateway as a container next to your app."
              detail="The configurator manages a helix-gateway container locally and bridges it onto your app's network."
              onClick={() => onSelect('docker')}
            />
            <CardButton
              icon={<Ship className="w-6 h-6" />}
              title="Kubernetes"
              tagline="Run the gateway in your cluster."
              detail="We generate everything; you kubectl / helm install it. Next, choose how your apps get instrumented."
              onClick={() => setStage('k8s-instrument')}
            />
          </div>
          <div className="flex items-center justify-center pt-2">
            <a href="/step-zero" className="text-tiny text-gray-400 hover:text-gray-200 underline">No collector or instrumented apps yet? Start from zero →</a>
          </div>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-center text-gray-100">How do you want to instrument your apps?</h1>
          <p className="text-sm text-gray-400 text-center">Both run the same Helix gateway in your cluster. You can change this later.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CardButton
              icon={<Wrench className="w-6 h-6" />}
              title="Manual (Helm chart)"
              tagline="Generate a chart you install; instrument apps yourself."
              detail="A self-contained gateway chart pre-wired to Helix — point your already-instrumented apps (or your own collector) at it. No Operator required."
              onClick={() => onSelect('kubernetes')}
            />
            <CardButton
              icon={<Boxes className="w-6 h-6" />}
              title="OTel Operator (auto-instrument)"
              tagline="Zero-code instrumentation, Operator-managed gateway."
              detail="Annotate a pod and the agent is injected for you (Java / Node / Python / .NET). One-time cluster install of cert-manager + the OTel Operator — the wizard gives you the exact commands."
              onClick={() => onSelect('kubernetes-operator')}
            />
          </div>
          <div className="flex items-center justify-center pt-2">
            <button onClick={() => setStage('platform')} className="inline-flex items-center gap-1.5 text-tiny text-gray-400 hover:text-gray-200">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to platform
            </button>
          </div>
        </>
      )}
    </div>
  );
};
