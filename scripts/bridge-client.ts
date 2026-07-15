import path from 'node:path';

import {
  BRIDGE_HTTP_URL,
  BRIDGE_WS_URL,
  type BridgeCommand,
  type BridgeMessage,
  type BridgeResponse,
} from '../src/protocol';

interface BridgeHealth {
  ok: boolean;
  extensionConnected: boolean;
}

const root = path.resolve(import.meta.dir, '..');

export async function ensureBridge(): Promise<BridgeHealth> {
  const current = await getHealth();
  if (current) return current;

  const child = Bun.spawn({
    cmd: [process.execPath, path.join(root, 'scripts/bridge.ts')],
    cwd: root,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const health = await getHealth();
    if (health) return health;
  }
  throw new Error('Could not start the local Browser Gate bridge.');
}

export async function invokeBridge<T>(
  command: BridgeCommand,
  params?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const health = await ensureBridge();
  if (!health.extensionConnected) await waitForExtension();
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = new WebSocket(BRIDGE_WS_URL);
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${command}.`)), timeoutMs);

    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve(result as T);
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'cli' } satisfies BridgeMessage));
      socket.send(JSON.stringify({ type: 'request', id, command, params } satisfies BridgeMessage));
    });
    socket.addEventListener('message', event => {
      const response = JSON.parse(String(event.data)) as BridgeResponse;
      if (response.type !== 'response' || response.id !== id) return;
      response.ok ? finish(undefined, response.result) : finish(new Error(response.error ?? 'Extension request failed.'));
    });
    socket.addEventListener('error', () => finish(new Error('Could not connect to the local Browser Gate bridge.')));
  });
}

async function waitForExtension(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(100);
    const health = await getHealth();
    if (health?.extensionConnected) return;
  }
}

async function getHealth(): Promise<BridgeHealth | null> {
  try {
    const response = await fetch(`${BRIDGE_HTTP_URL}/health`, { signal: AbortSignal.timeout(250) });
    return response.ok ? (await response.json()) as BridgeHealth : null;
  } catch {
    return null;
  }
}
