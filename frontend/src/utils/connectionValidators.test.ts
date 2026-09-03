import { describe, it, expect } from 'vitest';
import { validateConnectionFields } from './connectionValidators';

const ok = { name: 'A', endpoint: 'https://t.onbmc.com', apiKey: 'T::A::S', xSource: 'svc', signals: { traces: true, metrics: false, logs: false } };

describe('validateConnectionFields', () => {
  it('accepts a valid connection', () => { expect(validateConnectionFields(ok).valid).toBe(true); });
  it('rejects /otlp in endpoint', () => { expect(validateConnectionFields({ ...ok, endpoint: 'https://t/otlp' }).errors.endpoint).toBeTruthy(); });
  it('rejects a two-part api key', () => { expect(validateConnectionFields({ ...ok, apiKey: 'T::A' }).errors.apiKey).toBeTruthy(); });
  it('requires at least one signal', () => { expect(validateConnectionFields({ ...ok, signals: { traces: false, metrics: false, logs: false } }).errors.signals).toBeTruthy(); });
});
