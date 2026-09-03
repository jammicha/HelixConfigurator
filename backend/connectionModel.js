// Pure helpers for the connection data model: slugs, env-key naming, and
// validation. No I/O. Mirrored on the frontend by connectionValidators.ts;
// keep the two rule sets in sync.
const MANAGED_PREFIX = 'otlphttp/bmchelix_';
const LEGACY_EXPORTER = 'otlphttp/bmchelix';

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const ensureUniqueId = (base, existingIds) => {
  const taken = new Set(existingIds);
  const root = base || 'connection';
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const envSuffix = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');
const exporterName = (id) => `${MANAGED_PREFIX}${id}`;

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

const validateConnection = (input = {}) => {
  const errors = {};
  const name = (input.name || '').trim();
  if (!name) errors.name = 'Required';

  const endpoint = (input.endpoint || '').trim();
  if (!endpoint) errors.endpoint = 'Required';
  else if (!/^https?:\/\//i.test(endpoint)) errors.endpoint = 'Must start with https://';
  else if (/\/otlp(\/|$)/.test(endpoint)) errors.endpoint = 'Remove /otlp/... The gateway adds the path itself.';
  else { try { new URL(endpoint); } catch { errors.endpoint = 'Not a valid URL'; } }

  const apiKey = (input.apiKey || '').trim();
  if (!apiKey) errors.apiKey = 'Required';
  else {
    const parts = apiKey.split('::');
    if (parts.length !== 3 || parts.some((p) => !p.trim())) {
      errors.apiKey = 'Must be three non-empty :: separated parts';
    }
  }

  const xSource = input.xSource || '';
  if (!xSource) errors.xSource = 'Required';
  else if (xSource !== xSource.trim()) errors.xSource = 'No leading or trailing whitespace';
  else if (CONTROL_CHARS.test(xSource)) errors.xSource = 'Cannot contain control characters';

  const s = input.signals || {};
  if (!s.traces && !s.metrics && !s.logs) errors.signals = 'Enable at least one signal';

  return { valid: Object.keys(errors).length === 0, errors };
};

const normalizeConnection = (input = {}, { id }) => {
  const s = input.signals || {};
  return {
    id,
    name: (input.name || '').trim(),
    endpoint: (input.endpoint || '').trim(),
    xSource: input.xSource || '',
    businessServiceKey: (input.businessServiceKey || '').trim(),
    eventsEndpoint: (input.eventsEndpoint || '').trim(),
    signals: {
      traces: s.traces !== false,
      metrics: s.metrics !== false,
      logs: s.logs !== false,
    },
    enabled: input.enabled !== false,
  };
};

module.exports = {
  MANAGED_PREFIX, LEGACY_EXPORTER,
  slugify, ensureUniqueId, envSuffix, exporterName,
  validateConnection, normalizeConnection,
};
