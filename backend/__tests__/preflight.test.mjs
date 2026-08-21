import { describe, it, expect, vi } from 'vitest';
import { classifyPortOwnership, reportPortOwnership } from '../preflight.js';

const ID = 'instance-under-test';

// Build a fetch stub that answers per-host. `answers` maps a substring of the
// URL to either a response-like object or the string 'reject'.
const stubFetch = (answers) => vi.fn(async (url) => {
  for (const [needle, answer] of Object.entries(answers)) {
    if (String(url).includes(needle)) {
      if (answer === 'reject') throw new Error('socket hang up');
      return answer;
    }
  }
  throw new Error('unexpected url ' + url);
});

const jsonOk = (body) => ({ ok: true, json: async () => body });

describe('classifyPortOwnership', () => {
  it('reports healthy when both stacks answer with our own instance id', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
    expect(v.ipv4).toBe('self');
    expect(v.ipv6).toBe('self');
  });

  it('names a foreign listener when the IPv4 bind was refused and IPv4 answers as someone else', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: 'someone-else' }),
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.verdict).toBe('ipv4-foreign');
    expect(v.ipv4).toBe('foreign');
    expect(v.message).toContain('8765');
    expect(v.remediation).toContain('Docker');
  });

  it('detects the stale-proxy fingerprint: IPv4 bind refused and IPv4 connections dropped', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': 'reject',
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.verdict).toBe('ipv4-unreachable');
    expect(v.ipv4).toBe('unreachable');
    expect(v.message).toContain('accepts connections');
    expect(v.remediation).toContain('Docker');
  });

  it('treats a non-JSON response on our port as a foreign listener', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': { ok: true, json: async () => { throw new Error('not json'); } },
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.ipv4).toBe('foreign');
  });

  it('trusts a successful IPv4 bind even when the loopback probe is blocked', async () => {
    const fetchImpl = stubFetch({ '127.0.0.1': 'reject', '[::1]': 'reject' });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
  });

  it('names the MIRROR split-brain: IPv4 bound but something foreign answers on IPv6', async () => {
    // The symmetric case of the bug this module exists to name. index.js
    // swallows the EADDRINUSE, IPv4 binds, so ipv4Bound is true — but the
    // user's browser resolves localhost to ::1 first and reaches the other
    // process. Short-circuiting on ipv4Bound reported this as healthy.
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': jsonOk({ ok: true, instanceId: 'someone-else' }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('ipv6-foreign');
    expect(v.ipv4).toBe('self');
    expect(v.ipv6).toBe('foreign');
    expect(v.message).toContain('8765');
    // The fan-out is the half that still works here, so the message must not
    // claim otherwise; 127.0.0.1 is the working way in meanwhile.
    expect(v.remediation).toContain('127.0.0.1:8765');
  });

  it('a non-JSON answer on the IPv6 side also counts as foreign', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': { ok: true, json: async () => { throw new Error('not json'); } },
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('ipv6-foreign');
  });

  it('stays healthy on an IPv6-less host where only IPv4 bound and answers', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': 'reject',
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
    expect(v.ipv6).toBe('unreachable');
  });
});

describe('reportPortOwnership', () => {
  it('prints nothing when healthy', () => {
    const log = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    reportPortOwnership({ verdict: 'healthy', message: '', remediation: '' }, { log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('uses the verdict\'s own headline so the mirror case is not mislabelled as a fan-out failure', () => {
    const log = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    reportPortOwnership(
      {
        verdict: 'ipv6-foreign',
        headline: 'Your browser may not be reaching this configurator.',
        message: 'MSG',
        remediation: 'FIX',
      },
      { log },
    );
    const printed = log.warn.mock.calls.flat().join('\n');
    expect(printed).toContain('Your browser may not be reaching this configurator.');
    expect(printed).not.toContain('Local viewer fan-out will not work.');
  });

  it('warns with both the message and the remediation when degraded', () => {
    const log = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    reportPortOwnership(
      { verdict: 'ipv4-unreachable', message: 'MSG', remediation: 'FIX' },
      { log },
    );
    const printed = log.warn.mock.calls.flat().join('\n');
    expect(printed).toContain('MSG');
    expect(printed).toContain('FIX');
  });
});
