// Fetching the update banner's "can this install update itself?" probe.
//
// Extracted from UpdateBanner.tsx so it can be unit-tested: this project has
// no DOM test harness, so logic living inside a component effect is logic
// nobody can check.
//
// Why the retry exists: the probe used to be a one-shot fetch with a swallowed
// error. Any blip while the backend was restarting left the capability null
// for the life of the page, and the banner fell back to generic "re-run your
// install command" text — hiding both the real remediation hint and, on a
// native install, the working update button.

export type Capability = { supported: boolean; mode: string; hint?: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchCapabilityWithRetry(
  fetchImpl: typeof fetch,
  {
    attempts = 3,
    delayMs = 1500,
    sleep = defaultSleep,
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Capability | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl('/api/update/capability');
      // A non-ok response is not an answer: a 502 from a restarting backend and
      // a 401 from a gated route both mean "ask again", not "no capability".
      if (res.ok) return (await res.json()) as Capability;
    } catch {
      // Network-level failure; fall through to the retry.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return null;
}
