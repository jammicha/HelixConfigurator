import { describe, it, expect } from 'vitest';
import { computeViewerFanoutCellState, type VerifyFanoutResponse } from './viewerFanoutVerdict';

const okResponse: VerifyFanoutResponse = {
  verdict: 'ok',
  traceId: 'abc123',
  detail: '',
  remediation: '',
  elapsedMs: 42,
  counters: { sent: 1, failed: 0 },
};

describe('computeViewerFanoutCellState', () => {
  it('ok verdict -> pass, no error, no remediation', () => {
    const s = computeViewerFanoutCellState(okResponse);
    expect(s.status).toBe('ok');
    expect(s.error).toBe('');
    expect(s.remediation).toBe('');
  });

  it('gateway-unreachable verdict -> fail, surfaces detail + remediation naming the OTLP receiver', () => {
    const s = computeViewerFanoutCellState({
      ...okResponse,
      verdict: 'gateway-unreachable',
      detail: 'connect ECONNREFUSED',
      remediation: 'Check that the gateway container is running and that port 4318 is published.',
      counters: null,
    });
    expect(s.status).toBe('FAIL');
    expect(s.error).toBe('connect ECONNREFUSED');
    expect(s.remediation).toContain('gateway');
  });

  it('fanout-failed verdict -> fail, surfaces the "never came back" detail', () => {
    const s = computeViewerFanoutCellState({
      ...okResponse,
      verdict: 'fanout-failed',
      detail: 'Span accepted by the gateway but not received back within 15000ms.',
      remediation: 'Check the gateway logs for otlphttp/helix_local_viewer errors.',
      counters: { sent: 5, failed: 0 },
    });
    expect(s.status).toBe('FAIL');
    expect(s.error).toContain('not received back');
    expect(s.remediation).toContain('helix_local_viewer');
  });

  it('error verdict (canary itself threw) -> fail, surfaces the crash detail', () => {
    const s = computeViewerFanoutCellState({
      ...okResponse,
      verdict: 'error',
      detail: 'SQLITE_BUSY: database is locked',
      remediation: 'Retry the check; if it keeps happening, check the configurator backend logs.',
      counters: null,
    });
    expect(s.status).toBe('FAIL');
    expect(s.error).toBe('SQLITE_BUSY: database is locked');
    expect(s.remediation).toContain('Retry');
  });

  it('counters: null does not change the verdict mapping (metrics endpoint merely unreachable)', () => {
    const s = computeViewerFanoutCellState({ ...okResponse, counters: null });
    expect(s.status).toBe('ok');
  });

  it('missing detail falls back to the verdict string itself', () => {
    const s = computeViewerFanoutCellState({
      ...okResponse,
      verdict: 'fanout-failed',
      detail: '',
      remediation: '',
      counters: null,
    });
    expect(s.status).toBe('FAIL');
    expect(s.error).toBe('fanout-failed');
  });

  it('null response (in-flight canary) -> checking, no error, no remediation', () => {
    const s = computeViewerFanoutCellState(null);
    expect(s.status).toBe('CHECKING');
    expect(s.error).toBe('');
    expect(s.remediation).toBe('');
  });
});
