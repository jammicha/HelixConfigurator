// Pure decision logic for Step 4's "are we good?" verdict + whether to show the
// collector-error panel. Extracted from Step4.tsx so it can be unit-tested in
// isolation (the JSX-coupled version kept producing false positives that only
// showed up at runtime). No React, no I/O — all inputs passed in.
//
// This reads the user's *real* telemetry only. Onboarding no longer injects a
// synthetic gateway→Helix trace, so there are no synthetic inputs here — the
// "is my key/endpoint valid against Helix?" check lives on Step 1 (Test
// connection), and post-launch confidence comes from the dashboard.

export type VerifyInputs = {
  // Any of spans/metrics/logs increased since the step opened (telemetry is
  // actually reaching the gateway right now).
  flowing: boolean;
  // Collector has a helix-bound export error within the recent window.
  ongoingErrors: boolean;
  // Collector logged any helix-bound export errors at all (ongoing or cleared).
  hasErrors: boolean;
  gatewayNotRunning: boolean;
};

export type VerifyState = {
  tone: 'good' | 'warn' | 'bad' | 'idle';
  title: string;
  detail: string;
  step?: number;                          // a wizard step to jump to, if actionable
  errorPanel: 'warning' | 'muted' | 'none';
};

export function computeVerifyState(i: VerifyInputs): VerifyState {
  const clearedOnly = i.hasErrors && !i.ongoingErrors;

  let v: Omit<VerifyState, 'errorPanel'>;
  if (i.gatewayNotRunning) {
    v = { tone: 'warn', title: "Helix gateway isn't running", detail: "Telemetry can't flow until it's back up — restart it below." };
  } else if (i.ongoingErrors && !i.flowing) {
    // Genuinely broken: the collector is erroring AND nothing is arriving.
    v = { tone: 'warn', title: "Your collector can't reach the gateway yet", detail: "Bridge it to helix-gateway in Step 3. If you just started or restarted, give it a few seconds — these retries often clear on their own.", step: 3 };
  } else if (i.flowing) {
    // Telemetry is getting through. If there are also retry log lines, the
    // collector is just catching up via its retry queue — reassure, don't alarm.
    v = {
      tone: 'good',
      title: 'Telemetry is flowing to Helix',
      detail: i.hasErrors
        ? 'Your telemetry is reaching Helix — a few startup connection retries are clearing on their own as the collector catches up.'
        : 'Your telemetry is reaching the gateway and on to Helix.',
    };
  } else {
    v = { tone: 'idle', title: 'Waiting for telemetry…', detail: 'Start your app or collector to see your spans here.' };
  }

  // Alarm only when broken (ongoing errors AND nothing arriving). When flowing,
  // show NO panel — the retry lines are noise the queue is overcoming. A muted
  // note covers cleared retries only when the green verdict isn't already saying it.
  const errorPanel: VerifyState['errorPanel'] =
    (i.ongoingErrors && !i.flowing) ? 'warning'
      : (clearedOnly && v.tone !== 'good') ? 'muted'
        : 'none';

  return { ...v, errorPanel };
}
