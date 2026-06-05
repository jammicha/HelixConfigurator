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
