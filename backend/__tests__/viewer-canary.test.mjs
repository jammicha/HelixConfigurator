import { describe, it, expect, vi } from 'vitest';
import { runViewerCanary, CANARY_SERVICE_NAME } from '../viewerCanary.js';
import { DIAGNOSTIC_NAMESPACE } from '../util.js';

const noSleep = async () => {};

describe('runViewerCanary', () => {
  it('returns ok as soon as the injected trace appears in the store', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = {
      getTrace: vi.fn((id) => (id === 'fixed-trace-id' ? { summary: {}, spans: [{ spanId: 'a' }] } : null)),
    };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, traceId: 'fixed-trace-id',
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('ok');
    expect(r.traceId).toBe('fixed-trace-id');
    expect(axiosImpl.post).toHaveBeenCalledOnce();
    expect(axiosImpl.post.mock.calls[0][0]).toBe('http://localhost:4318/v1/traces');
  });

  it('tags the span with the canary service name so it is filterable in the UI', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: () => ({ summary: {}, spans: [{ spanId: 'a' }] }) };
    await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://localhost:4318' });
    const payload = axiosImpl.post.mock.calls[0][1];
    const attrs = payload.resourceSpans[0].resource.attributes;
    expect(attrs).toContainEqual({ key: 'service.name', value: { stringValue: CANARY_SERVICE_NAME } });
  });

  it('groups under the shared internal diagnostic namespace, not a second invented one', async () => {
    // The canary span traverses the gateway's full pipeline, so it also
    // ships to otlphttp/bmchelix and lands in the CUSTOMER's Helix tenant —
    // once per ladder run and once per Diagnostics-drawer open. inject-trace
    // already carries DIAGNOSTIC_NAMESPACE precisely so Helix groups
    // synthetic traces away from the customer's AIOps topology; a
    // canary-specific namespace would be a second internal namespace in
    // their tenant.
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: () => ({ summary: {}, spans: [{ spanId: 'a' }] }) };
    await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://localhost:4318' });
    const attrs = axiosImpl.post.mock.calls[0][1].resourceSpans[0].resource.attributes;
    expect(attrs).toContainEqual({ key: 'service.namespace', value: { stringValue: DIAGNOSTIC_NAMESPACE } });
    expect(DIAGNOSTIC_NAMESPACE).not.toBe(CANARY_SERVICE_NAME);
  });

  it('reports gateway-unreachable when the OTLP receiver refuses the injection', async () => {
    const axiosImpl = { post: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) };
    const otelStore = { getTrace: vi.fn(() => null) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('gateway-unreachable');
    expect(r.detail).toContain('ECONNREFUSED');
    expect(otelStore.getTrace).not.toHaveBeenCalled();
  });

  it('reports fanout-failed when the gateway accepts the span but it never comes back', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: vi.fn(() => null) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, timeoutMs: 30, pollIntervalMs: 10,
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('fanout-failed');
    expect(otelStore.getTrace).toHaveBeenCalled();
  });

  it('treats a stored trace with zero spans as not yet arrived', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: vi.fn(() => ({ summary: {}, spans: [] })) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, timeoutMs: 30, pollIntervalMs: 10,
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('fanout-failed');
  });

  it('generates a unique 32-hex trace id when none is supplied', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: () => ({ summary: {}, spans: [{ spanId: 'a' }] }) };
    const a = await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://x:4318' });
    const b = await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://x:4318' });
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).not.toBe(b.traceId);
  });
});
