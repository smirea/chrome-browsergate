export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 17373;
export const BRIDGE_HTTP_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const BRIDGE_WS_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`;

export type BridgeRole = 'cli' | 'extension';
export type BridgeCommand =
  | 'tabs.list'
  | 'session.get'
  | 'automations.list'
  | 'automations.run';

export interface BrowserWindow {
  id: number;
  order: number;
  focused: boolean;
  incognito: boolean;
  type: string;
}

export interface BrowserTab {
  id: number;
  windowId: number;
  windowOrder: number;
  index: number;
  active: boolean;
  title: string;
  url: string;
}

export interface TabsListResult {
  windows: BrowserWindow[];
  tabs: BrowserTab[];
}

export interface SessionResult {
  tab: BrowserTab;
  strategy: string;
  token: string;
  tokenType: 'bearer' | 'cookie' | 'value';
  source: 'authorization-header' | 'local-storage' | 'session-storage' | 'cookie';
}

export interface AutomationSummary {
  id: string;
  matches: string[];
  world: 'ISOLATED' | 'MAIN';
}

export interface BridgeHello {
  type: 'hello';
  role: BridgeRole;
}

export interface BridgeRequest {
  type: 'request';
  id: string;
  command: BridgeCommand;
  params?: unknown;
}

export interface BridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type BridgeMessage =
  | BridgeHello
  | BridgeRequest
  | BridgeResponse
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'reload' };
