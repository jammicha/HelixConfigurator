const DOCKER_UNAVAILABLE_RE = /docker\.sock|docker daemon|cannot connect to docker|enoent.*docker/i;

// Poll the gateway lifecycle status until it reports "running" or the timeout
// elapses. Used after env/config changes that recreate the container so the
// UI doesn't proceed (verify, restart flows) against a still-starting gateway.
// Network blips during startup are swallowed and retried.
export const waitForGatewayRunning = async (
  timeoutMs = 15000,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/lifecycle/status');
      const data = await res.json();
      if (data.status === 'running') return { ok: true };
      if (data.status === 'error' && typeof data.error === 'string' && DOCKER_UNAVAILABLE_RE.test(data.error)) {
        return {
          ok: false,
          error: 'Docker is not running. Start Docker Desktop, then try again.',
        };
      }
    } catch { /* network blip — keep trying */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, error: 'Gateway did not reach running state within 15s' };
};
