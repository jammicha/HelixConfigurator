import { describe, it, expect } from 'vitest';
import { computeVerifyState, type VerifyInputs } from './verifyVerdict';

const base: VerifyInputs = {
  flowing: false,
  ongoingErrors: false, hasErrors: false, gatewayNotRunning: false,
};

describe('computeVerifyState', () => {
  // The reported bug: green "Telemetry is flowing" + climbing counters, yet the
  // scary "ERRORS DETECTED" panel still showed because the collector was logging
  // retry lines while its queue caught up. Flowing must win — no panel.
  it('flowing + ongoing retries → good verdict, NO error panel (catch-up, not failure)', () => {
    const s = computeVerifyState({ ...base, flowing: true, ongoingErrors: true, hasErrors: true });
    expect(s.tone).toBe('good');
    expect(s.errorPanel).toBe('none');
    expect(s.detail.toLowerCase()).toContain('catch');
  });

  it('NOT flowing + ongoing errors → warn (Step 3) with the warning panel', () => {
    const s = computeVerifyState({ ...base, ongoingErrors: true, hasErrors: true });
    expect(s.tone).toBe('warn');
    expect(s.step).toBe(3);
    expect(s.errorPanel).toBe('warning');
  });

  it('flowing + cleared errors → good, no panel', () => {
    const s = computeVerifyState({ ...base, flowing: true, hasErrors: true, ongoingErrors: false });
    expect(s.tone).toBe('good');
    expect(s.errorPanel).toBe('none');
  });

  it('idle + cleared retries (nothing flowing) → idle with a muted note', () => {
    const s = computeVerifyState({ ...base, hasErrors: true, ongoingErrors: false });
    expect(s.tone).toBe('idle');
    expect(s.errorPanel).toBe('muted');
  });

  it('gateway not running takes priority', () => {
    const s = computeVerifyState({ ...base, gatewayNotRunning: true, flowing: true });
    expect(s.tone).toBe('warn');
  });

  it('nothing yet → idle, no panel', () => {
    const s = computeVerifyState(base);
    expect(s.tone).toBe('idle');
    expect(s.errorPanel).toBe('none');
  });
});
