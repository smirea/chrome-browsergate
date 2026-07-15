#!/usr/bin/env bun
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeRole,
} from '../src/protocol';

interface SocketData {
  role?: BridgeRole;
}

type Socket = Bun.ServerWebSocket<SocketData>;

let extension: Socket | null = null;
const pending = new Map<string, Socket>();

const server = Bun.serve<SocketData>({
  hostname: BRIDGE_HOST,
  port: BRIDGE_PORT,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, extensionConnected: extension !== null });
    }
    if (url.pathname === '/reload' && request.method === 'POST') {
      if (extension) extension.send(JSON.stringify({ type: 'reload' } satisfies BridgeMessage));
      return Response.json({ ok: true, extensionConnected: extension !== null });
    }
    if (server.upgrade(request, { data: {} })) return;
    return new Response('Browser Gate', { status: 200 });
  },
  websocket: {
    open() {},
    message(socket, raw) {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.type === 'hello') {
        socket.data.role = message.role;
        if (message.role === 'extension') extension = socket;
        return;
      }
      if (message.type === 'request') {
        routeRequest(socket, message);
        return;
      }
      if (message.type === 'response') routeResponse(message);
    },
    close(socket) {
      if (socket === extension) extension = null;
      for (const [id, client] of pending) {
        if (client === socket) pending.delete(id);
      }
    },
  },
});

setInterval(() => {
  extension?.send(JSON.stringify({ type: 'ping' } satisfies BridgeMessage));
}, 20_000);

console.log(`Browser Gate bridge listening on ws://${server.hostname}:${server.port}`);

function routeRequest(client: Socket, request: BridgeRequest): void {
  if (client.data.role !== 'cli') return;
  if (!extension) {
    client.send(JSON.stringify({
      type: 'response',
      id: request.id,
      ok: false,
      error: 'The extension is not connected. Run \"bun run install-extension\" and load dist in chrome://extensions.',
    } satisfies BridgeResponse));
    return;
  }
  pending.set(request.id, client);
  extension.send(JSON.stringify(request));
}

function routeResponse(response: BridgeResponse): void {
  const client = pending.get(response.id);
  if (!client) return;
  pending.delete(response.id);
  client.send(JSON.stringify(response));
}

function parseMessage(raw: string | Buffer): BridgeMessage | null {
  try {
    return JSON.parse(String(raw)) as BridgeMessage;
  } catch {
    return null;
  }
}
