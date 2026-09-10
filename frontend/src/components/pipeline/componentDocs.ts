import { baseType } from './pipelineGraph';

export type ConceptCard = { title: string; body: string; docsUrl?: string };
export type ComponentDoc = { role: string; whyItMatters: string; concept?: ConceptCard };

// Resolved by exact component name first (e.g. the two named Helix exporters),
// then by base type, then a generic fallback.
const BY_NAME: Record<string, ComponentDoc> = {
  'otlphttp/bmchelix': {
    role: 'Ships your telemetry to the BMC Helix tenant over OTLP/HTTP.',
    whyItMatters:
      'This is the egress to Helix. Its endpoint and the X-Api-Key, X-Source headers decide which tenant and business service your data lands in. Get these wrong and data either fails to send or arrives on the wrong service.',
  },
  'otlphttp/helix_local_viewer': {
    role: 'Fans a copy of every signal to this configurator so the View OTel Data page can render it locally.',
    whyItMatters:
      'This is why you can inspect traces, logs, and errors inside the app without Jaeger or an external store. Removing it disables the local viewer; it does not affect what Helix receives.',
  },
};

const BY_TYPE: Record<string, ComponentDoc> = {
  otlp: {
    role: 'Receives OpenTelemetry data from your apps.',
    whyItMatters:
      'This is the front door of the collector. Your instrumented apps send here. If the endpoint or protocol does not match what your app exports, nothing arrives.',
    concept: {
      title: 'gRPC vs HTTP',
      body:
        'The OTLP receiver can listen on gRPC (port 4317) and HTTP (port 4318). gRPC is binary and efficient for high volume; HTTP is easier through proxies and firewalls. Your app must target the same protocol and port the receiver enables.',
      docsUrl: 'https://opentelemetry.io/docs/specs/otlp/',
    },
  },
  otlphttp: {
    role: 'Sends telemetry onward to another OTLP/HTTP endpoint.',
    whyItMatters:
      'Exporters are the collector outputs. An OTLP/HTTP exporter forwards batches to a downstream endpoint; the endpoint and headers decide where the data goes.',
  },
  prometheus: {
    role: 'Scrapes Prometheus metrics endpoints and turns them into OTel metrics.',
    whyItMatters:
      'Use this to pull metrics from targets that expose a /metrics endpoint instead of pushing OTLP. The scrape config decides what gets collected and how often.',
  },
  batch: {
    role: 'Groups spans, metrics, and logs into batches before export.',
    whyItMatters:
      'Batching cuts network overhead and load on the destination. Almost every production pipeline includes it; without it the collector makes many small, inefficient sends.',
  },
  memory_limiter: {
    role: 'Caps the collector memory and sheds load when it climbs too high.',
    whyItMatters:
      'It protects the collector from running out of memory under bursts by refusing data early rather than crashing. Place it first so it can push back before other processors work.',
  },
  resource: {
    role: 'Adds, edits, or removes resource attributes on your telemetry.',
    whyItMatters:
      'Resource attributes describe where data came from (service.name, deployment.environment, and so on). Helix and OTel back-ends group and route on these, so setting them correctly is what makes your data findable.',
    concept: {
      title: 'Resource attributes and semantic conventions',
      body:
        'Semantic conventions are the agreed names for common attributes (service.name, host.name, k8s.pod.name). Using the conventional names, rather than your own, is what lets back-ends and dashboards understand your data without custom mapping.',
      docsUrl: 'https://opentelemetry.io/docs/specs/semconv/',
    },
  },
  k8sattributes: {
    role: 'Enriches telemetry with Kubernetes metadata (pod, namespace, node, labels).',
    whyItMatters:
      'It automatically stamps each signal with the pod and namespace it came from, so you can slice by workload in Helix without instrumenting that context yourself.',
    concept: {
      title: 'Resource attributes and semantic conventions',
      body:
        'This processor fills in k8s.* resource attributes using the conventional names. Downstream tools rely on those exact names to build topology and group by workload.',
      docsUrl: 'https://opentelemetry.io/docs/specs/semconv/resource/k8s/',
    },
  },
  tail_sampling: {
    role: 'Decides which completed traces to keep, based on the whole trace.',
    whyItMatters:
      'High-volume tracing is expensive to store. Tail sampling waits until a trace finishes so it can keep the interesting ones (errors, slow traces) and drop routine ones, unlike head sampling which decides blindly at the start.',
    concept: {
      title: 'Sampling: head vs tail',
      body:
        'Head sampling decides at the first span, before you know if the trace is interesting. Tail sampling buffers spans and decides once the trace is complete, so you can keep every error and slow trace while dropping the rest. Tail sampling costs more memory in the collector.',
      docsUrl: 'https://opentelemetry.io/docs/concepts/sampling/',
    },
  },
};

const GENERIC: ComponentDoc = {
  role: 'A collector component not covered by a built-in explainer.',
  whyItMatters:
    'Look this component up in the OpenTelemetry registry to see what it receives, transforms, or exports.',
  concept: {
    title: 'Find this component',
    body: 'Search the OpenTelemetry registry for this component name to read its documentation and configuration options.',
    docsUrl: 'https://opentelemetry.io/ecosystem/registry/',
  },
};

export function resolveDoc(componentName: string): ComponentDoc {
  return BY_NAME[componentName] || BY_TYPE[baseType(componentName)] || GENERIC;
}
