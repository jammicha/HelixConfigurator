// Mirror of backend/connectionModel.js validation. Keep the two in sync; the
// server re-validates, so this is for inline UX only.
export type Signals = { traces: boolean; metrics: boolean; logs: boolean };
export type ConnectionInput = {
  name: string; endpoint: string; apiKey?: string; xSource: string; signals: Signals;
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export function validateConnectionFields(input: ConnectionInput): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input.name?.trim()) errors.name = 'Required';

  const endpoint = input.endpoint?.trim() || '';
  if (!endpoint) errors.endpoint = 'Required';
  else if (!/^https?:\/\//i.test(endpoint)) errors.endpoint = 'Must start with https://';
  else if (/\/otlp(\/|$)/.test(endpoint)) errors.endpoint = 'Remove /otlp/... The gateway adds the path itself.';
  else { try { new URL(endpoint); } catch { errors.endpoint = 'Not a valid URL'; } }

  const apiKey = input.apiKey?.trim() || '';
  if (!apiKey) errors.apiKey = 'Required';
  else { const p = apiKey.split('::'); if (p.length !== 3 || p.some((x) => !x.trim())) errors.apiKey = 'Must be three non-empty :: separated parts'; }

  const xSource = input.xSource || '';
  if (!xSource) errors.xSource = 'Required';
  else if (xSource !== xSource.trim()) errors.xSource = 'No leading or trailing whitespace';
  else if (CONTROL_CHARS.test(xSource)) errors.xSource = 'Cannot contain control characters';

  const s = input.signals || { traces: false, metrics: false, logs: false };
  if (!s.traces && !s.metrics && !s.logs) errors.signals = 'Enable at least one signal';

  return { valid: Object.keys(errors).length === 0, errors };
}
