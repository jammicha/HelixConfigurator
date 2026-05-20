import { describe, it, expect } from 'vitest';
import { renderSnippet } from '../routes/step-zero/instrument-templates.js';

describe('renderSnippet', () => {
  const baseArgs = { serviceName: 'cart-api' };

  describe('java', () => {
    it('compose-mode includes JAVA_TOOL_OPTIONS and helix-bridge network', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'compose' });
      expect(out.compose).toContain('OTEL_SERVICE_NAME: cart-api');
      expect(out.compose).toContain('OTEL_EXPORTER_OTLP_ENDPOINT: http://helix-gateway:4318');
      expect(out.compose).toContain('JAVA_TOOL_OPTIONS');
      expect(out.compose).toContain('-javaagent:/otel-agent/opentelemetry-javaagent.jar');
      expect(out.compose).toContain('helix-bridge');
      expect(out.compose).toContain('external: true');
    });
    it('host-mode uses localhost endpoint and omits networks block', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'host' });
      expect(out.shell).toContain('http://localhost:4318');
      expect(out.shell).toContain('-javaagent:');
      expect(out.compose).toContain('http://localhost:4318');
      expect(out.compose).not.toContain('helix-bridge');
    });
    it('standalone-mode uses host.docker.internal', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'standalone' });
      expect(out.compose).toContain('http://host.docker.internal:4318');
    });
    it('exposes agentDownload URL for Java', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'compose' });
      expect(out.agentDownload).toMatch(/opentelemetry-javaagent\.jar$/);
    });
  });

  describe('python', () => {
    it('compose-mode prefixes command with opentelemetry-instrument', () => {
      const out = renderSnippet({ ...baseArgs, language: 'python', endpointMode: 'compose' });
      expect(out.compose).toContain('opentelemetry-instrument');
      expect(out.prereqs).toContain('pip install');
    });
    it('shell-mode is a wrapper command', () => {
      const out = renderSnippet({ ...baseArgs, language: 'python', endpointMode: 'host' });
      expect(out.shell).toContain('opentelemetry-instrument');
    });
  });

  describe('node', () => {
    it('sets NODE_OPTIONS with the auto-instrumentations require', () => {
      const out = renderSnippet({ ...baseArgs, language: 'node', endpointMode: 'compose' });
      expect(out.compose).toContain('NODE_OPTIONS');
      expect(out.compose).toContain('@opentelemetry/auto-instrumentations-node/register');
      expect(out.prereqs).toContain('npm install');
    });
  });

  describe('dotnet', () => {
    it('sets CoreCLR profiler env vars', () => {
      const out = renderSnippet({ ...baseArgs, language: 'dotnet', endpointMode: 'compose' });
      expect(out.compose).toContain('CORECLR_ENABLE_PROFILING');
      expect(out.compose).toContain('CORECLR_PROFILER');
      expect(out.compose).toContain('DOTNET_STARTUP_HOOKS');
      expect(out.prereqs).toMatch(/install/);
    });
  });

  it('throws for unknown language', () => {
    expect(() => renderSnippet({ language: 'rust', serviceName: 'x', endpointMode: 'compose' })).toThrow(/language/i);
  });

  it('throws for unknown endpointMode', () => {
    expect(() => renderSnippet({ language: 'java', serviceName: 'x', endpointMode: 'kubernetes' })).toThrow(/endpointMode/i);
  });

  describe('manual SDK section', () => {
    it('includes manual snippets for every language × every mode', () => {
      const langs = ['java', 'python', 'node', 'dotnet'];
      const modes = ['compose', 'standalone', 'host'];
      for (const language of langs) {
        for (const endpointMode of modes) {
          const out = renderSnippet({ language, serviceName: 'x', endpointMode });
          expect(out.manual.install).toBeTruthy();
          expect(out.manual.init).toBeTruthy();
          expect(out.manual.spanExample).toBeTruthy();
          expect(out.manual.docsUrl).toMatch(/^https:\/\/opentelemetry\.io\//);
          expect(out.zeroCodeDocsUrl).toMatch(/^https:\/\/opentelemetry\.io\//);
        }
      }
    });

    it('java manual init uses AutoConfiguredOpenTelemetrySdk', () => {
      const out = renderSnippet({ language: 'java', serviceName: 'x', endpointMode: 'compose' });
      expect(out.manual.init).toContain('AutoConfiguredOpenTelemetrySdk');
    });

    it('python manual init wires OTLPSpanExporter', () => {
      const out = renderSnippet({ language: 'python', serviceName: 'x', endpointMode: 'compose' });
      expect(out.manual.init).toContain('OTLPSpanExporter');
      expect(out.manual.install).toContain('pip install');
    });

    it('node manual init uses NodeSDK + OTLPTraceExporter', () => {
      const out = renderSnippet({ language: 'node', serviceName: 'x', endpointMode: 'compose' });
      expect(out.manual.init).toContain('NodeSDK');
      expect(out.manual.init).toContain('OTLPTraceExporter');
    });

    it('dotnet manual init uses AddOpenTelemetry + AddOtlpExporter', () => {
      const out = renderSnippet({ language: 'dotnet', serviceName: 'x', endpointMode: 'compose' });
      expect(out.manual.init).toContain('AddOpenTelemetry');
      expect(out.manual.init).toContain('AddOtlpExporter');
    });
  });

  describe('official-docs alignment', () => {
    const langs = ['java', 'python', 'node', 'dotnet'];
    const modes = ['compose', 'standalone', 'host'];

    it('every language × mode sets OTEL_TRACES_EXPORTER=otlp in compose env', () => {
      for (const language of langs) {
        for (const endpointMode of modes) {
          const out = renderSnippet({ language, serviceName: 'x', endpointMode });
          // Compose YAML form
          expect(out.compose).toContain('OTEL_TRACES_EXPORTER: otlp');
        }
      }
    });

    it('every language sets OTEL_TRACES_EXPORTER=otlp in the shell wrapper', () => {
      for (const language of langs) {
        const out = renderSnippet({ language, serviceName: 'x', endpointMode: 'host' });
        // Shell-wrapper form (matches both `OTEL_TRACES_EXPORTER=otlp \` and `export OTEL_TRACES_EXPORTER=otlp`)
        expect(out.shell).toMatch(/OTEL_TRACES_EXPORTER=otlp/);
      }
    });

    it('uses the current deployment.environment.name semantic convention (not the old deployment.environment)', () => {
      for (const language of langs) {
        for (const endpointMode of modes) {
          const out = renderSnippet({ language, serviceName: 'x', endpointMode });
          expect(out.compose).toContain('deployment.environment.name=dev');
          expect(out.compose).not.toMatch(/deployment\.environment=dev/);
          expect(out.shell).toContain('deployment.environment.name=dev');
        }
      }
    });

    it('python prereqs no longer install the redundant opentelemetry-instrumentation package', () => {
      const out = renderSnippet({ language: 'python', serviceName: 'x', endpointMode: 'compose' });
      expect(out.prereqs).toContain('pip install opentelemetry-distro opentelemetry-exporter-otlp');
      expect(out.prereqs).not.toContain('opentelemetry-instrumentation');
    });

    it('prereqs no longer reference the removed Apply-for-me feature', () => {
      for (const language of langs) {
        const out = renderSnippet({ language, serviceName: 'x', endpointMode: 'compose' });
        expect(out.prereqs).not.toMatch(/Apply for me/i);
      }
    });
  });
});
