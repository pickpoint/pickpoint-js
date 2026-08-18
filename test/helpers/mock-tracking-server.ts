import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  decodeClientMsg,
  encodeServerMsg,
  TRACKING_SUBPROTOCOL,
  type ClientMsg,
  type ServerMsg,
} from '@pickpoint/sdk/tracking';
import { ErrorCode } from '@pickpoint/sdk/tracking';

export const MOCK_TRACK_UID = '11111111-1111-1111-1111-111111111111';
export const MOCK_NODE_ID = '00000000-0000-0000-0000-000000000001';

export type MockBehavior = {
  /** Called for each client message after Hello. */
  onClientMsg?: (msg: ClientMsg, ctx: MockConn) => void;
  /** If set, send Relocate instead of Hello on first connection. */
  relocateOnConnect?: { endpoint: string; retryAfterMs?: number };
  /** Auto-handle common device flows when true (default). */
  auto?: boolean;
  /**
   * Awaited before Hello/Relocate on each connection (1-based index).
   * Useful to publish offline points before resume runs.
   */
  beforeHello?: (connectionIndex: number, ctx: MockConn) => void | Promise<void>;
};

export type MockConn = {
  send: (msg: ServerMsg) => void;
  close: (code?: number, reason?: string) => void;
  readonly messages: ClientMsg[];
};

export type MockTrackingServer = {
  readonly url: string;
  readonly origin: string;
  close(): Promise<void>;
  /** Connections accepted so far (order preserved). */
  readonly connections: MockConn[];
  waitForConnection(timeoutMs?: number): Promise<MockConn>;
  waitForMessage(
    pred: (msg: ClientMsg) => boolean,
    timeoutMs?: number,
  ): Promise<ClientMsg>;
};

export async function startMockTrackingServer(
  behavior: MockBehavior = {},
): Promise<MockTrackingServer> {
  const auto = behavior.auto !== false;
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) =>
      protocols.has(TRACKING_SUBPROTOCOL) ? TRACKING_SUBPROTOCOL : false,
  });

  const connections: MockConn[] = [];
  const connWaiters: Array<(c: MockConn) => void> = [];
  const allMessages: ClientMsg[] = [];
  const msgWaiters: Array<{
    pred: (msg: ClientMsg) => boolean;
    resolve: (msg: ClientMsg) => void;
  }> = [];

  wss.on('connection', (ws: WebSocket) => {
    const messages: ClientMsg[] = [];
    const conn: MockConn = {
      messages,
      send(msg) {
        ws.send(encodeServerMsg(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    connections.push(conn);
    for (const w of connWaiters.splice(0)) w(conn);
    const connectionIndex = connections.length;

    void (async () => {
      try {
        await behavior.beforeHello?.(connectionIndex, conn);
      } catch {
        /* ignore */
      }
      if (behavior.relocateOnConnect && connectionIndex === 1) {
        conn.send({
          type: 'relocate',
          endpoint: behavior.relocateOnConnect.endpoint,
          retryAfterMs: behavior.relocateOnConnect.retryAfterMs ?? 0,
        });
      } else {
        conn.send({
          type: 'hello',
          version: 2,
          shard: 0,
          nodeId: MOCK_NODE_ID,
        });
      }
    })();

    let lastAck = 0;
    let activeTrack = MOCK_TRACK_UID;
    let nextSub = 1;
    const subByDevice = new Map<string, number>();

    ws.on('message', (raw) => {
      const bytes =
        raw instanceof Buffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw as ArrayBuffer);
      const msg = decodeClientMsg(bytes);
      messages.push(msg);
      allMessages.push(msg);
      for (let i = msgWaiters.length - 1; i >= 0; i--) {
        if (msgWaiters[i]!.pred(msg)) {
          msgWaiters[i]!.resolve(msg);
          msgWaiters.splice(i, 1);
        }
      }

      behavior.onClientMsg?.(msg, conn);

      if (!auto) {
        return;
      }

      switch (msg.type) {
        case 'trackStart':
          activeTrack = MOCK_TRACK_UID;
          conn.send({
            type: 'trackStarted',
            trackUid: MOCK_TRACK_UID,
            metadata: new Uint8Array(),
          });
          break;
        case 'trackStop':
          conn.send({
            type: 'trackStopped',
            trackUid: activeTrack,
          });
          break;
        case 'resume':
          conn.send({
            type: 'resumeOk',
            trackUid: msg.trackUid,
            lastAckedSeq: lastAck,
          });
          break;
        case 'loc': {
          lastAck = msg.seq;
          conn.send({ type: 'ack', seq: msg.seq });
          break;
        }
        case 'subscribe': {
          const existing = subByDevice.get(msg.deviceUid);
          const sub = existing ?? nextSub++;
          subByDevice.set(msg.deviceUid, sub);
          conn.send({
            type: 'subscribed',
            sub,
            deviceUid: msg.deviceUid,
            trackUid: MOCK_TRACK_UID,
            online: true,
            route: [],
            estimatedDistance: 0,
            estimatedDuration: 0,
            startLocationName: '',
            endLocationName: '',
            metadata: new Uint8Array(),
          });
          break;
        }
        default:
          break;
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind mock server');
  }
  const origin = `ws://127.0.0.1:${addr.port}`;

  return {
    url: origin,
    origin,
    connections,
    async close() {
      for (const c of connections) {
        try {
          c.close(1000, 'mock close');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
    waitForConnection(timeoutMs = 5_000) {
      if (connections.length) {
        return Promise.resolve(connections[connections.length - 1]!);
      }
      return withTimeout(
        new Promise<MockConn>((resolve) => connWaiters.push(resolve)),
        timeoutMs,
        'waitForConnection',
      );
    },
    waitForMessage(pred, timeoutMs = 5_000) {
      const existing = allMessages.find(pred);
      if (existing) {
        return Promise.resolve(existing);
      }
      return withTimeout(
        new Promise<ClientMsg>((resolve) => {
          msgWaiters.push({ pred, resolve });
        }),
        timeoutMs,
        'waitForMessage',
      );
    },
  };
}

export function serverError(code: ErrorCode, message: string): ServerMsg {
  return { type: 'error', code, message };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
