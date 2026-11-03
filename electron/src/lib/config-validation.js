// Renderer-side input validation for configuration forms (pure, no IPC).
// Mirrors the main-process rules closely enough for instant inline
// feedback; the main process always re-validates authoritatively.
// Covered by electron/test/config-validation.test.mjs.

/** Non-empty trimmed text, or an error message. */
export function validateRequired(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${label} is required.`;
  }
  return null;
}

/** Bounded name field (vault: 1..80 chars). */
export function validateName(value, label = 'Name') {
  const missing = validateRequired(value, label);
  if (missing) return missing;
  if (value.trim().length > 80) return `${label} must be 80 characters or fewer.`;
  return null;
}

/** API key field (vault: non-empty, under 4096 chars). Never logged. */
export function validateKeyInput(value) {
  if (typeof value !== 'string' || value === '' || value.length > 4096) {
    return 'Paste the API key. It must be under 4096 characters.';
  }
  if (value.trim() === '') return 'Paste the API key.';
  return null;
}

/** Explicit model ID field (custom: 1..200 chars, single line). */
export function validateModelInput(value) {
  const missing = validateRequired(value, 'Model');
  if (missing) return missing;
  if (value.trim().length > 200) return 'Model ID must be 200 characters or fewer.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Model ID contains invalid characters.';
  return null;
}

function blockedHost(hostname) {
  const host = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::' || host === '[::1]') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (host.includes(':')) {
    const compact = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/:/g, '');
    if (host.replace(/^\[|\]$/g, '') === '::1') return true;
    if (/^(fe80|fec0|fc00|fd00)/.test(compact)) return true;
    return false;
  }
  return false;
}

/**
 * Custom endpoint URL field. Returns an error string, or null when the
 * value passes the same rules the main process enforces (public HTTPS,
 * no credentials/query/fragment). The normalized URL is intentionally
 * not returned: the main process canonicalizes authoritatively.
 */
export function validateEndpointInput(value) {
  const missing = validateRequired(value, 'Endpoint URL');
  if (missing) return missing;
  const trimmed = value.trim();
  if (trimmed.length > 2048) return 'Endpoint URL must be 2048 characters or fewer.';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a valid HTTPS URL, for example https://llm.example.com/v1.';
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    return 'Endpoint URL must be HTTPS without credentials, query, or fragment.';
  }
  if (blockedHost(url.hostname)) {
    return 'Endpoints on local or private networks are not allowed.';
  }
  return null;
}
