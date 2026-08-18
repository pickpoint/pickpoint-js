import type { WebSocketConstructor, WebSocketLike } from './types';
import { TRACKING_SUBPROTOCOL } from './url';

let cachedNodeWs: WebSocketConstructor | undefined;

async function loadNodeWebSocket(): Promise<WebSocketConstructor> {
  if (cachedNodeWs) {
    return cachedNodeWs;
  }
  const mod = await import('ws');
  cachedNodeWs = (mod.WebSocket ?? mod.default) as unknown as WebSocketConstructor;
  return cachedNodeWs;
}

/**
 * Resolve a WebSocket constructor for the current runtime.
 * Browser: globalThis.WebSocket. Node: `ws` package.
 */
export async function resolveWebSocketCtor(
  override?: WebSocketConstructor,
): Promise<WebSocketConstructor> {
  if (override) {
    return override;
  }
  const g = globalThis as { WebSocket?: WebSocketConstructor };
  if (typeof g.WebSocket === 'function') {
    // Node 22+ may expose undici WebSocket; prefer it when present.
    return g.WebSocket;
  }
  return loadNodeWebSocket();
}

export function openSocket(
  Ctor: WebSocketConstructor,
  url: string,
): WebSocketLike {
  const socket = new Ctor(url, TRACKING_SUBPROTOCOL) as WebSocketLike;
  // Required for binary frames in browsers.
  try {
    socket.binaryType = 'arraybuffer';
  } catch {
    /* ignore */
  }
  return socket;
}

export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;
