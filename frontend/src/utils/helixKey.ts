// Helix's UI sometimes hands users the API key split across two fields:
//   Key details: <seg1>::<seg2>,Tenant ID: <digits>
// The actual X-API-Key header value is "<tenantId>::<seg1>::<seg2>". This
// pulls the pieces from a pasted blob (any order, any separator) and rebuilds
// the canonical key. Returns null if the blob doesn't look like that bundle.
export const parseHelixKeyBundle = (raw: string): string | null => {
  if (!raw) return null;
  const keyMatch = raw.match(/Key\s*details\s*:\s*([A-Za-z0-9]+)::([A-Za-z0-9]+)/i);
  const tenantMatch = raw.match(/Tenant\s*ID\s*:\s*(\d+)/i);
  if (!keyMatch || !tenantMatch) return null;
  return `${tenantMatch[1]}::${keyMatch[1]}::${keyMatch[2]}`;
};

// Accept a bare AIOps business-service key, a URL path fragment, or a full
// AIOps URL and return just the opaque key. Used to build the deep-link into
// the configured Business Service.
export const extractServiceKey = (input: string): string => {
  if (!input) return '';
  const trimmed = input.trim();
  const match = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
  if (match) return match[1];
  return trimmed.split(/[?#\s]/)[0];
};
