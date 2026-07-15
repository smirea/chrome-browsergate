export interface BrowserAutomation {
  id: string;
  matches: string[];
  world?: 'ISOLATED' | 'MAIN';
  run: (url: string) => void | Promise<void>;
}

export const automations: BrowserAutomation[] = [];

export function automationMatches(url: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchPattern(url, pattern));
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file):/.test(value);
  const parsed = pattern.match(/^(\*|https?|file):\/\/([^/]*)(\/.*)$/);
  if (!parsed) return globMatches(value, pattern);

  const url = new URL(value);
  const [, protocol, hostname, pathname] = parsed;
  if (protocol !== '*' && url.protocol !== `${protocol}:`) return false;
  if (hostname.startsWith('*.')) {
    const domain = hostname.slice(2);
    if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return false;
  } else if (hostname !== '*' && url.hostname !== hostname) {
    return false;
  }
  return globMatches(`${url.pathname}${url.search}${url.hash}`, pathname);
}

function globMatches(value: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${expression}$`).test(value);
}
