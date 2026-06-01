import { useEffect, useState } from 'react';

type TestResult = {
  status: string;
  message: string;
  remediation?: string;
  httpStatus?: number;
  latencyMs?: number;
} | null;

// "Test Connection" action for the Helix settings form: POSTs the endpoint +
// key to the probe and surfaces the verdict. The stale result is cleared
// whenever the endpoint or key changes so a previous verdict can't mislead
// after the user edits either field.
export const useTestConnection = (endpoint: string, apiKey: string) => {
  const [testConnectionResult, setTestConnectionResult] = useState<TestResult>(null);
  const [testingConnection, setTestingConnection] = useState(false);

  const handleTestConnection = async () => {
    if (testingConnection) return;
    setTestingConnection(true);
    setTestConnectionResult(null);
    try {
      const res = await fetch('/api/diagnostics/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, apiKey }),
      });
      const data = await res.json();
      setTestConnectionResult({
        status: data.status || (res.ok ? 'unknown' : 'error'),
        message: data.message || data.error || 'Test finished',
        remediation: data.remediation,
        httpStatus: data.httpStatus,
        latencyMs: data.latencyMs,
      });
    } catch (e: any) {
      setTestConnectionResult({ status: 'error', message: e?.message || 'Request failed' });
    } finally {
      setTestingConnection(false);
    }
  };

  useEffect(() => {
    setTestConnectionResult(null);
  }, [endpoint, apiKey]);

  return { testConnectionResult, testingConnection, handleTestConnection };
};
