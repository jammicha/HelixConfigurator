// Poll the gateway lifecycle status until it reports "running" or the timeout
// elapses. Used after env/config changes that recreate the container so the
// UI doesn't proceed (verify, restart flows) against a still-starting gateway.
// Network blips during startup are swallowed and retried.
export const waitForGatewayRunning = async (timeoutMs = 15000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/lifecycle/status');
      const data = await res.json();
      if (data.status === 'running') return true;
    } catch { /* network blip — keep trying */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};
