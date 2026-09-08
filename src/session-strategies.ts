export interface SessionStrategy {
  id: string;
  domains: string[];
  requestUrlPatterns: string[];
  storageKeyPatterns: string[];
  cookieNamePatterns: string[];
  cookieMode: 'none' | 'matching' | 'all';
  cookieFirst?: boolean;
}

export interface StorageEntry {
  area: 'local-storage' | 'session-storage';
  key: string;
  value: string;
}

export interface CookieEntry {
  name: string;
  value: string;
}

export interface CredentialMatch {
  token: string;
  source: StorageEntry['area'] | 'cookie';
  tokenType: 'cookie' | 'value';
}

const TOKEN_KEYS = [
  '^access[_-]?token$',
  '^auth[_-]?token$',
  '^id[_-]?token$',
  '^session[_-]?token$',
  'authorization',
  'access[_-]?token',
  'bearer',
];

export const sessionStrategies: SessionStrategy[] = [
  {
    id: 'airbnb',
    domains: ['airbnb.com'],
    requestUrlPatterns: [],
    storageKeyPatterns: [],
    cookieNamePatterns: [],
    cookieMode: 'all',
    cookieFirst: true,
  },
  {
    id: 'clocktracker',
    domains: ['clocktracker.app'],
    requestUrlPatterns: [],
    storageKeyPatterns: [],
    cookieNamePatterns: [],
    cookieMode: 'all',
    cookieFirst: true,
  },
  {
    id: 'cookunity',
    domains: ['cookunity.com'],
    requestUrlPatterns: ['^https://(?:[^/]+\\.)?cookunity\\.com/(?:sdui-service|subscription-back)/'],
    storageKeyPatterns: TOKEN_KEYS,
    cookieNamePatterns: [],
    cookieMode: 'none',
  },
];

export const defaultSessionStrategy: SessionStrategy = {
  id: 'generic',
  domains: [],
  requestUrlPatterns: ['^https?://'],
  storageKeyPatterns: TOKEN_KEYS,
  cookieNamePatterns: ['session', 'auth', 'token', 'jwt'],
  cookieMode: 'all',
};

export function strategyForUrl(url: string): SessionStrategy {
  const hostname = new URL(url).hostname;
  return (
    sessionStrategies.find(strategy =>
      strategy.domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)),
    ) ?? defaultSessionStrategy
  );
}

export function requestMatchesStrategy(url: string, strategy: SessionStrategy): boolean {
  return strategy.requestUrlPatterns.some(pattern => new RegExp(pattern, 'i').test(url));
}

export function normalizeAuthorization(value: string): { token: string; tokenType: 'bearer' | 'value' } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bearer = trimmed.match(/^Bearer\s+(.+)$/i);
  return bearer
    ? { token: bearer[1].trim(), tokenType: 'bearer' }
    : { token: trimmed, tokenType: 'value' };
}

export function findStorageCredential(
  entries: StorageEntry[],
  strategy: SessionStrategy,
): CredentialMatch | null {
  const patterns = strategy.storageKeyPatterns.map(pattern => new RegExp(pattern, 'i'));
  const ordered = [...entries].sort(
    (left, right) => keyRank(left.key, patterns) - keyRank(right.key, patterns),
  );

  for (const entry of ordered) {
    const keyMatches = patterns.some(pattern => pattern.test(entry.key));
    const token = credentialFromValue(entry.value, patterns, keyMatches);
    if (token) return { token, source: entry.area, tokenType: 'value' };
  }

  return null;
}

export function findCookieCredential(
  cookies: CookieEntry[],
  strategy: SessionStrategy,
): CredentialMatch | null {
  if (strategy.cookieMode === 'none') return null;
  const patterns = strategy.cookieNamePatterns.map(pattern => new RegExp(pattern, 'i'));
  const matching = cookies.find(cookie => patterns.some(pattern => pattern.test(cookie.name)));
  if (matching?.value) return { token: matching.value, source: 'cookie', tokenType: 'cookie' };
  if (strategy.cookieMode !== 'all' || cookies.length === 0) return null;
  return {
    token: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    source: 'cookie',
    tokenType: 'cookie',
  };
}

function keyRank(key: string, patterns: RegExp[]): number {
  const rank = patterns.findIndex(pattern => pattern.test(key));
  return rank === -1 ? patterns.length : rank;
}

function credentialFromValue(value: string, keyPatterns: RegExp[], allowDirect: boolean): string | null {
  if (allowDirect) {
    const direct = normalizeCandidate(value);
    if (direct) return direct;
  }

  try {
    return credentialFromJson(JSON.parse(value) as unknown, keyPatterns, 0);
  } catch {
    const jwt = value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jwt?.[0] ?? null;
  }
}

function credentialFromJson(value: unknown, keyPatterns: RegExp[], depth: number): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = credentialFromJson(item, keyPatterns, depth + 1);
      if (token) return token;
    }
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (!keyPatterns.some(pattern => pattern.test(key))) continue;
    if (typeof item === 'string') {
      const token = normalizeCandidate(item);
      if (token) return token;
    }
    const nested = credentialFromJson(item, keyPatterns, depth + 1);
    if (nested) return nested;
  }

  for (const item of Object.values(value)) {
    const nested = credentialFromJson(item, keyPatterns, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function normalizeCandidate(value: string): string | null {
  let candidate = value.trim();
  if (!candidate || candidate.length > 20_000) return null;
  if (/^[{[]/.test(candidate)) return null;
  candidate = candidate.replace(/^['"]|['"]$/g, '');
  candidate = candidate.replace(/^Bearer\s+/i, '').trim();
  if (candidate.length < 16 || /\s/.test(candidate)) return null;
  return candidate;
}
