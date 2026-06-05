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
    detail: "The configurator manages a helix-gateway container locally and bridges it onto your app's network.",
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
