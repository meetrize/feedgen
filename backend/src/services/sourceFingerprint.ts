import { createHash } from 'crypto';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
]);

export function normalizeUrl(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  let scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme === 'http') {
    scheme = 'https';
  }

  let host = parsed.hostname.toLowerCase();
  let port = parsed.port;
  if (
    (scheme === 'https' && port === '443') ||
    (scheme === 'http' && port === '80') ||
    port === ''
  ) {
    port = '';
  }

  const hostWithPort = port ? `${host}:${port}` : host;

  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
      params.delete(key);
    }
  }
  const sortedParams = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const search = sortedParams.length
    ? `?${sortedParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';

  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  return `${scheme}://${hostWithPort}${pathname}${search}${parsed.hash}`;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

export function canonicalizeSelectorRules(rules: object | null | undefined): string {
  if (!rules || typeof rules !== 'object') {
    return '';
  }
  const sorted = sortObjectKeys(rules);
  return JSON.stringify(sorted);
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function buildSourceFingerprint(input: {
  url: string;
  source_type: 'native' | 'parsed' | string;
  selector_rules?: object | null;
}): string {
  const urlNorm = normalizeUrl(input.url);
  const sourceType = String(input.source_type || 'native').toLowerCase();

  if (sourceType === 'native') {
    return sha256(`native:${urlNorm}`);
  }

  const rulesCanon = canonicalizeSelectorRules(input.selector_rules ?? undefined);
  return sha256(`parsed:${urlNorm}:${rulesCanon}`);
}

export function buildSelectorFingerprint(selector_rules?: object | null): string | null {
  const canon = canonicalizeSelectorRules(selector_rules ?? undefined);
  if (!canon) return null;
  return sha256(canon);
}
