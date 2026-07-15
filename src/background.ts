import { automationMatches, automations, type BrowserAutomation } from './automations';
import {
  BRIDGE_WS_URL,
  type AutomationSummary,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type BrowserTab,
  type BrowserWindow,
  type SessionResult,
  type TabsListResult,
} from './protocol';
import {
  findCookieCredential,
  findStorageCredential,
  normalizeAuthorization,
  requestMatchesStrategy,
  strategyForUrl,
  type SessionStrategy,
  type StorageEntry,
} from './session-strategies';

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 500;

const automationRuns = new Map<string, string>();

connect();
void chrome.alarms.create('browser-gate-connect', { periodInMinutes: 0.5 });

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener(connect);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.url || (change.status !== 'complete' && !(change.url && tab.status === 'complete'))) return;
  void runMatchingAutomations(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of automationRuns.keys()) {
    if (key.startsWith(`${tabId}:`)) automationRuns.delete(key);
  }
});

function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  socket = new WebSocket(BRIDGE_WS_URL);
  socket.addEventListener('open', () => {
    reconnectDelay = 500;
    send({ type: 'hello', role: 'extension' });
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: 'Browser Gate: connected' });
  });
  socket.addEventListener('message', event => void handleMessage(event.data));
  socket.addEventListener('close', reconnect);
  socket.addEventListener('error', () => socket?.close());
}

function reconnect(): void {
  socket = null;
  void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  void chrome.action.setBadgeText({ text: '!' });
  void chrome.action.setTitle({ title: 'Browser Gate: local bridge offline' });
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

async function handleMessage(raw: unknown): Promise<void> {
  const message = parseMessage(raw);
  if (!message) return;
  if (message.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
  if (message.type === 'reload') {
    chrome.runtime.reload();
    return;
  }
  if (message.type !== 'request') return;

  try {
    const result = await handleRequest(message);
    respond({ type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    respond({
      type: 'response',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRequest(request: BridgeRequest): Promise<unknown> {
  switch (request.command) {
    case 'tabs.list':
      return listTabs();
    case 'session.get': {
      const target = readStringParam(request.params, 'target');
      return getSession(target);
    }
    case 'automations.list':
      return automations.map<AutomationSummary>(automation => ({
        id: automation.id,
        matches: automation.matches,
        world: automation.world ?? 'ISOLATED',
      }));
    case 'automations.run': {
      const id = readStringParam(request.params, 'id');
      const target = readOptionalStringParam(request.params, 'target');
      return runAutomationCommand(id, target);
    }
  }
}

async function listTabs(): Promise<TabsListResult> {
  const chromeWindows = await chrome.windows.getAll();
  const windows: BrowserWindow[] = chromeWindows.flatMap((window, order) =>
    window.id === undefined
      ? []
      : [{
          id: window.id,
          order,
          focused: window.focused,
          incognito: window.incognito,
          type: window.type ?? 'normal',
        }],
  );
  const windowOrders = new Map(windows.map(window => [window.id, window.order]));
  const tabs = (await chrome.tabs.query({})).flatMap<BrowserTab>(tab => {
    if (tab.id === undefined || tab.windowId === undefined) return [];
    return [{
      id: tab.id,
      windowId: tab.windowId,
      windowOrder: windowOrders.get(tab.windowId) ?? Number.MAX_SAFE_INTEGER,
      index: tab.index,
      active: tab.active,
      title: tab.title ?? '(untitled)',
      url: tab.url ?? '',
    }];
  });
  tabs.sort((left, right) => left.windowOrder - right.windowOrder || left.index - right.index);
  return { windows, tabs };
}

async function getSession(target: string): Promise<SessionResult> {
  const tab = await resolveTab(target);
  if (!/^https?:/.test(tab.url)) throw new Error(`Cannot extract a session from ${tab.url || 'this tab'}.`);
  await activateTab(tab);
  const strategy = strategyForUrl(tab.url);

  const authorization = await captureAuthorization(tab.id, strategy);
  if (authorization) {
    return {
      tab,
      strategy: strategy.id,
      token: authorization.token,
      tokenType: authorization.tokenType,
      source: 'authorization-header',
    };
  }

  const storage = await readPageStorage(tab.id);
  const stored = findStorageCredential(storage, strategy);
  if (stored) {
    return { tab, strategy: strategy.id, ...stored };
  }

  const cookies = await chrome.cookies.getAll({ url: tab.url });
  const cookie = findCookieCredential(cookies, strategy);
  if (cookie) {
    return { tab, strategy: strategy.id, ...cookie };
  }

  throw new Error(`No session credential was found for ${new URL(tab.url).hostname}. Add a domain strategy in src/session-strategies.ts.`);
}

async function captureAuthorization(
  tabId: number,
  strategy: SessionStrategy,
): Promise<ReturnType<typeof normalizeAuthorization>> {
  const target: chrome.debugger.Debuggee = { tabId };
  const requestUrls = new Map<string, string>();
  const extraHeaders = new Map<string, Record<string, unknown>>();
  let finish: (value: ReturnType<typeof normalizeAuthorization>) => void = () => {};
  const captured = new Promise<ReturnType<typeof normalizeAuthorization>>(resolve => {
    const timer = setTimeout(() => resolve(null), 12_000);
    finish = value => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  const inspect = (url: string | undefined, headers: Record<string, unknown> | undefined) => {
    if (!url || !headers || !requestMatchesStrategy(url, strategy)) return;
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue;
      const authorization = normalizeAuthorization(value);
      if (authorization) finish(authorization);
    }
  };
  const listener = (source: chrome.debugger.DebuggerSession, method: string, rawParams?: object) => {
    if (source.tabId !== tabId || !rawParams) return;
    const params = rawParams as Record<string, unknown>;
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    if (method === 'Network.requestWillBeSent' && requestId) {
      const request = params.request as Record<string, unknown> | undefined;
      const url = typeof request?.url === 'string' ? request.url : undefined;
      const headers = request?.headers as Record<string, unknown> | undefined;
      if (url) requestUrls.set(requestId, url);
      inspect(url, headers);
      inspect(url, extraHeaders.get(requestId));
    }
    if (method === 'Network.requestWillBeSentExtraInfo' && requestId) {
      const headers = params.headers as Record<string, unknown> | undefined;
      if (headers) extraHeaders.set(requestId, headers);
      inspect(requestUrls.get(requestId), headers);
    }
  };

  try {
    await chrome.debugger.attach(target, '1.3');
    chrome.debugger.onEvent.addListener(listener);
    await chrome.debugger.sendCommand(target, 'Network.enable');
    await chrome.tabs.reload(tabId);
    return await captured;
  } catch {
    finish(null);
    return null;
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

async function readPageStorage(tabId: number): Promise<StorageEntry[]> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const entries: Array<{ area: 'local-storage' | 'session-storage'; key: string; value: string }> = [];
        const read = (storage: Storage, area: 'local-storage' | 'session-storage') => {
          for (let index = 0; index < Math.min(storage.length, 500); index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            entries.push({ area, key, value: (storage.getItem(key) ?? '').slice(0, 50_000) });
          }
        };
        read(localStorage, 'local-storage');
        read(sessionStorage, 'session-storage');
        return entries;
      },
    });
    return injection?.result ?? [];
  } catch {
    return [];
  }
}

async function resolveTab(target?: string): Promise<BrowserTab> {
  const listed = await listTabs();
  if (!target) {
    const focusedWindow = listed.windows.find(window => window.focused);
    const active = listed.tabs.find(tab => tab.active && tab.windowId === focusedWindow?.id)
      ?? listed.tabs.find(tab => tab.active);
    if (!active) throw new Error('No active tab found.');
    return active;
  }

  if (/^\d+$/.test(target)) {
    const number = Number(target);
    const tab = listed.tabs[number - 1];
    if (!tab) throw new Error(`Tab ${number} does not exist. Run \"invoke tabs list\" again.`);
    return tab;
  }

  const url = normalizeUrl(target);
  const existing = listed.tabs.find(tab => stripHash(tab.url) === stripHash(url));
  if (existing) return existing;
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id === undefined) throw new Error(`Chrome could not open ${url}.`);
  await waitUntilLoaded(created.id);
  const refreshed = await listTabs();
  const tab = refreshed.tabs.find(candidate => candidate.id === created.id);
  if (!tab) throw new Error(`Chrome opened ${url}, but the tab disappeared.`);
  return tab;
}

async function activateTab(tab: BrowserTab): Promise<void> {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

async function waitUntilLoaded(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the tab to load.')), 20_000);
    const listener = (updatedId: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (updatedId === tabId && change.status === 'complete') finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runMatchingAutomations(tabId: number, url: string): Promise<void> {
  for (const automation of automations) {
    if (!automationMatches(url, automation.matches)) continue;
    const key = `${tabId}:${automation.id}`;
    if (automationRuns.get(key) === url) continue;
    automationRuns.set(key, url);
    await executeAutomation(tabId, url, automation);
  }
}

async function runAutomationCommand(id: string, target?: string): Promise<{ id: string; tab: BrowserTab }> {
  const automation = automations.find(candidate => candidate.id === id);
  if (!automation) throw new Error(`Unknown automation \"${id}\".`);
  const tab = await resolveTab(target);
  await activateTab(tab);
  await executeAutomation(tab.id, tab.url, automation);
  return { id, tab };
}

async function executeAutomation(tabId: number, url: string, automation: BrowserAutomation): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: (automation.world ?? 'ISOLATED') as chrome.scripting.ExecutionWorld,
    func: automation.run,
    args: [url],
  });
}

function send(message: BridgeMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function respond(response: BridgeResponse): void {
  send(response);
}

function parseMessage(raw: unknown): BridgeMessage | null {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : String(raw)) as BridgeMessage;
  } catch {
    return null;
  }
}

function readStringParam(params: unknown, key: string): string {
  const value = readOptionalStringParam(params, key);
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

function readOptionalStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeUrl(value: string): string {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  return url.href;
}

function stripHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}
