// Step 0 Layer 3 — pure snippet renderer. Returns the compose patch +
// shell wrapper command + prereq notes + (Java only) agent download URL
// for a given language and endpoint mode. No I/O.

const VALID_LANGUAGES = ['java', 'python', 'dotnet', 'node'];
const VALID_MODES = ['compose', 'standalone', 'host'];

const ENDPOINT_BY_MODE = {
  compose: 'http://helix-gateway:4318',
  standalone: 'http://host.docker.internal:4318',
  host: 'http://localhost:4318',
};

const JAVA_AGENT_URL = 'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

const DOCS_BY_LANG = {
  java:   { zeroCode: 'https://opentelemetry.io/docs/zero-code/java/agent/',  sdk: 'https://opentelemetry.io/docs/languages/java/instrumentation/' },
  python: { zeroCode: 'https://opentelemetry.io/docs/zero-code/python/',      sdk: 'https://opentelemetry.io/docs/languages/python/instrumentation/' },
  dotnet: { zeroCode: 'https://opentelemetry.io/docs/zero-code/net/',         sdk: 'https://opentelemetry.io/docs/languages/dotnet/instrumentation/' },
  node:   { zeroCode: 'https://opentelemetry.io/docs/zero-code/js/',          sdk: 'https://opentelemetry.io/docs/languages/js/instrumentation/' },
};

const MANUAL_BY_LANG = {
  java: {
    install: [
      '<!-- Add to pom.xml -->',
      '<dependency>',
      '  <groupId>io.opentelemetry</groupId>',
      '  <artifactId>opentelemetry-api</artifactId>',
      '  <version>1.43.0</version>',
      '</dependency>',
      '<dependency>',
      '  <groupId>io.opentelemetry</groupId>',
      '  <artifactId>opentelemetry-sdk</artifactId>',
      '  <version>1.43.0</version>',
      '</dependency>',
      '<dependency>',
      '  <groupId>io.opentelemetry</groupId>',
      '  <artifactId>opentelemetry-exporter-otlp</artifactId>',
      '  <version>1.43.0</version>',
      '</dependency>',
      '<dependency>',
      '  <groupId>io.opentelemetry</groupId>',
      '  <artifactId>opentelemetry-sdk-extension-autoconfigure</artifactId>',
      '  <version>1.43.0</version>',
      '</dependency>',
    ].join('\n'),
    init: [
      '// Run once at app startup. Reads OTEL_* env vars',
      '// (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc.).',
      'import io.opentelemetry.api.OpenTelemetry;',
      'import io.opentelemetry.sdk.autoconfigure.AutoConfiguredOpenTelemetrySdk;',
      '',
      'OpenTelemetry openTelemetry =',
      '    AutoConfiguredOpenTelemetrySdk.initialize().getOpenTelemetrySdk();',
    ].join('\n'),
    spanExample: [
      'import io.opentelemetry.api.trace.Tracer;',
      'import io.opentelemetry.api.trace.Span;',
      'import io.opentelemetry.context.Scope;',
      '',
      'Tracer tracer = openTelemetry.getTracer("my-app");',
      '',
      'Span span = tracer.spanBuilder("process-order").startSpan();',
      'try (Scope scope = span.makeCurrent()) {',
      '  span.setAttribute("order.id", orderId);',
      '  // your business logic here',
      '} catch (Exception e) {',
      '  span.recordException(e);',
      '  throw e;',
      '} finally {',
      '  span.end();',
      '}',
    ].join('\n'),
  },
  python: {
    install: 'pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http',
    init: [
      '# Run once at app startup. Reads OTEL_* env vars',
      '# (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc.).',
      'from opentelemetry import trace',
      'from opentelemetry.sdk.trace import TracerProvider',
      'from opentelemetry.sdk.trace.export import BatchSpanProcessor',
      'from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter',
      'from opentelemetry.sdk.resources import Resource',
      '',
      'resource = Resource.create()  # picks up OTEL_SERVICE_NAME from env',
      'provider = TracerProvider(resource=resource)',
      'provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))',
      'trace.set_tracer_provider(provider)',
    ].join('\n'),
    spanExample: [
      'from opentelemetry import trace',
      '',
      'tracer = trace.get_tracer(__name__)',
      '',
      'with tracer.start_as_current_span("process-order") as span:',
      '    span.set_attribute("order.id", order_id)',
      '    # your business logic here',
    ].join('\n'),
  },
  node: {
    install: 'npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http',
    init: [
      '// Run once at the VERY top of your entry file (before requiring app code).',
      '// Reads OTEL_* env vars (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc.).',
      "const { NodeSDK } = require('@opentelemetry/sdk-node');",
      "const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');",
      '',
      'const sdk = new NodeSDK({',
      '  traceExporter: new OTLPTraceExporter(),',
      '});',
      'sdk.start();',
    ].join('\n'),
    spanExample: [
      "const { trace } = require('@opentelemetry/api');",
      '',
      "const tracer = trace.getTracer('my-app');",
      '',
      "tracer.startActiveSpan('process-order', (span) => {",
      '  try {',
      "    span.setAttribute('order.id', orderId);",
      '    // your business logic here',
      '  } catch (e) {',
      '    span.recordException(e);',
      '    throw e;',
      '  } finally {',
      '    span.end();',
      '  }',
      '});',
    ].join('\n'),
  },
  dotnet: {
    install: [
      'dotnet add package OpenTelemetry',
      'dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol',
      'dotnet add package OpenTelemetry.Extensions.Hosting',
    ].join('\n'),
    init: [
      '// ASP.NET Core 6+ — wire into the DI container in Program.cs.',
      '// Reads OTEL_* env vars (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc.).',
      'using OpenTelemetry.Trace;',
      'using OpenTelemetry.Resources;',
      '',
      'builder.Services.AddOpenTelemetry()',
      '    .ConfigureResource(r => r.AddService("my-app"))',
      '    .WithTracing(tracing => tracing',
      '        .AddSource("my-app")',
      '        .AddOtlpExporter());',
    ].join('\n'),
    spanExample: [
      'using System.Diagnostics;',
      '',
      'private static readonly ActivitySource ActivitySource = new("my-app");',
      '',
      'using (var activity = ActivitySource.StartActivity("process-order"))',
      '{',
      '    activity?.SetTag("order.id", orderId);',
      '    // your business logic here',
      '}',
    ].join('\n'),
  },
};

// Indent multiline string by N spaces.
const indent = (s, n) => s.split('\n').map(line => line ? ' '.repeat(n) + line : line).join('\n');

const composeEnvBlock = (serviceName, endpoint, extraLines = []) => {
  const lines = [
    `OTEL_SERVICE_NAME: ${serviceName}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT: ${endpoint}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf`,
    `OTEL_TRACES_EXPORTER: otlp`,
    `OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=dev,service.namespace=step-zero-instrumented`,
    ...extraLines,
  ];
  return lines.join('\n');
};

const networksBlockIfNeeded = (endpointMode) => {
  if (endpointMode !== 'compose') return '';
  return `    networks:\n      - helix-bridge\n\nnetworks:\n  helix-bridge:\n    external: true`;
};

const renderJava = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `JAVA_TOOL_OPTIONS: "-javaagent:/otel-agent/opentelemetry-javaagent.jar"`,
  ]);
  const composeVolume = endpointMode === 'compose'
    ? `\n    volumes:\n      - helix-otel-agents:/otel-agent:ro`
    : `\n    volumes:\n      - ./otel-agent:/otel-agent:ro  # mount the dir containing opentelemetry-javaagent.jar`;
  const volumesBlock = endpointMode === 'compose'
    ? `\n\nvolumes:\n  helix-otel-agents:\n    external: true`
    : '';
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    composeVolume.trimStart() ? composeVolume : '',
    networks ? `\n${networks}` : '',
    volumesBlock,
  ].filter(Boolean).join('\n');

  const shell = [
    `# 1. Download the agent JAR (one-time)`,
    `curl -fsSL -o /tmp/opentelemetry-javaagent.jar \\`,
    `  "${JAVA_AGENT_URL}"`,
    ``,
    `# 2. Run your app with the agent attached`,
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_TRACES_EXPORTER=otlp \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev,service.namespace=step-zero-instrumented \\`,
    `java -javaagent:/tmp/opentelemetry-javaagent.jar -jar your-app.jar`,
  ].join('\n');

  const prereqs = `Java agent JAR is self-contained. No image rebuild needed: download the JAR once and mount it into your container, or bake it into your image. The agent attaches via -javaagent or JAVA_TOOL_OPTIONS.`;

  return {
    compose,
    shell,
    prereqs,
    agentDownload: JAVA_AGENT_URL,
    manual: { ...MANUAL_BY_LANG.java, docsUrl: DOCS_BY_LANG.java.sdk },
    zeroCodeDocsUrl: DOCS_BY_LANG.java.zeroCode,
  };
};

const renderPython = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    `    command: opentelemetry-instrument python your-app.py  # replace with your actual command`,
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_TRACES_EXPORTER=otlp \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev,service.namespace=step-zero-instrumented \\`,
    `opentelemetry-instrument python your-app.py`,
  ].join('\n');

  const prereqs = `Inside the Python image, run:\n  pip install opentelemetry-distro opentelemetry-exporter-otlp\n  opentelemetry-bootstrap -a install\nAdd both lines to your Dockerfile, or rebuild your image once with them included. The distro package bundles the API, SDK, and the opentelemetry-bootstrap + opentelemetry-instrument tools.`;

  return {
    compose,
    shell,
    prereqs,
    agentDownload: null,
    manual: { ...MANUAL_BY_LANG.python, docsUrl: DOCS_BY_LANG.python.sdk },
    zeroCodeDocsUrl: DOCS_BY_LANG.python.zeroCode,
  };
};

const renderNode = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `NODE_OPTIONS: "--require @opentelemetry/auto-instrumentations-node/register"`,
  ]);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_TRACES_EXPORTER=otlp \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev,service.namespace=step-zero-instrumented \\`,
    `NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register" \\`,
    `node your-server.js`,
  ].join('\n');

  const prereqs = `Inside the Node image, run:\n  npm install @opentelemetry/auto-instrumentations-node @opentelemetry/api\nAdd to your package.json and rebuild your image.`;

  return {
    compose,
    shell,
    prereqs,
    agentDownload: null,
    manual: { ...MANUAL_BY_LANG.node, docsUrl: DOCS_BY_LANG.node.sdk },
    zeroCodeDocsUrl: DOCS_BY_LANG.node.zeroCode,
  };
};

const renderDotnet = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `CORECLR_ENABLE_PROFILING: "1"`,
    `CORECLR_PROFILER: "{918728DD-259F-4A6A-AC2B-B85E1B658318}"`,
    `CORECLR_PROFILER_PATH: /otel-dotnet-auto/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so`,
    `DOTNET_ADDITIONAL_DEPS: /otel-dotnet-auto/AdditionalDeps`,
    `DOTNET_SHARED_STORE: /otel-dotnet-auto/store`,
    `DOTNET_STARTUP_HOOKS: /otel-dotnet-auto/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll`,
    `OTEL_DOTNET_AUTO_HOME: /otel-dotnet-auto`,
  ]);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    `    volumes:`,
    `      - ./otel-dotnet-auto:/otel-dotnet-auto:ro  # populated by the OTel .NET install script`,
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `# 1. Install the OTel .NET auto-instrumentation (one-time)`,
    `curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -O`,
    `sh ./otel-dotnet-auto-install.sh`,
    `. $HOME/.otel-dotnet-auto/instrument.sh`,
    ``,
    `# 2. Set env + run your app`,
    `export OTEL_SERVICE_NAME=${serviceName}`,
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    `export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
    `export OTEL_TRACES_EXPORTER=otlp`,
    `export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=dev,service.namespace=step-zero-instrumented`,
    `dotnet YourApp.dll`,
  ].join('\n');

  const prereqs = `Run the OTel .NET auto-instrumentation installer once on your host or build image to populate /otel-dotnet-auto:\n  curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -O\n  sh ./otel-dotnet-auto-install.sh\nThen mount that directory into the container at /otel-dotnet-auto (read-only). The shell-wrapper variant sources $HOME/.otel-dotnet-auto/instrument.sh, which is equivalent to the env-var set above.`;

  return {
    compose,
    shell,
    prereqs,
    agentDownload: null,
    manual: { ...MANUAL_BY_LANG.dotnet, docsUrl: DOCS_BY_LANG.dotnet.sdk },
    zeroCodeDocsUrl: DOCS_BY_LANG.dotnet.zeroCode,
  };
};

const RENDERERS = {
  java: renderJava,
  python: renderPython,
  node: renderNode,
  dotnet: renderDotnet,
};

const renderSnippet = ({ language, serviceName, endpointMode }) => {
  if (!VALID_LANGUAGES.includes(language)) {
    throw new Error(`renderSnippet: unknown language "${language}" — expected one of ${VALID_LANGUAGES.join(', ')}`);
  }
  if (!VALID_MODES.includes(endpointMode)) {
    throw new Error(`renderSnippet: unknown endpointMode "${endpointMode}" — expected one of ${VALID_MODES.join(', ')}`);
  }
  if (!serviceName || typeof serviceName !== 'string') {
    throw new Error('renderSnippet: serviceName is required');
  }
  return RENDERERS[language]({ serviceName, endpointMode });
};

module.exports = { renderSnippet, VALID_LANGUAGES, VALID_MODES, JAVA_AGENT_URL };
