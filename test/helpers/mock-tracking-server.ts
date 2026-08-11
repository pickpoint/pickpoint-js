import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { create } from '@bufbuild/protobuf';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ClientMsgSchema,
  ErrorCode,
  ServerMsgSchema,
  TRACKING_SUBPROTOCOL,
  type ClientMsg,
  type ServerMsg,
} from '@pickpoint/sdk/tracking';

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
        ws.send(toBinary(ServerMsgSchema, msg));
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
        conn.send(
          create(ServerMsgSchema, {
            body: {
              case: 'relocate',
              value: {
                endpoint: behavior.relocateOnConnect.endpoint,
                retryAfterMs: behavior.relocateOnConnect.retryAfterMs ?? 0,
              },
            },
          }),
        );
      } else {
        conn.send(
          create(ServerMsgSchema, {
            body: { case: 'hello', value: { nodeId: 'mock-1', shard: 0 } },
          }),
        );
      }
    })();

    let lastAck = 0n;

    ws.on('message', (raw) => {
      const bytes =
        raw instanceof Buffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw as ArrayBuffer);
      const msg = fromBinary(ClientMsgSchema, bytes);
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

      switch (msg.body.case) {
        case 'trackStart':
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'trackStarted',
                value: { trackUid: 'track-mock-1' },
              },
            }),
          );
          break;
        case 'trackStop':
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'trackStopped',
                value: { trackUid: msg.body.value.trackUid },
              },
            }),
          );
          break;
        case 'resume':
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'resumeOk',
                value: {
                  trackUid: msg.body.value.trackUid,
                  lastAckedSeq: lastAck,
                },
              },
            }),
          );
          break;
        case 'locationAdd': {
          lastAck = msg.body.value.clientSeq;
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'locationAdded',
                value: {
                  deviceUid: 'dev-1',
                  trackUid: msg.body.value.trackUid,
                  point: msg.body.value.point,
                  clientSeq: msg.body.value.clientSeq,
                },
              },
            }),
          );
          break;
        }
        case 'locationBatch': {
          lastAck = msg.body.value.clientSeq;
          const points = msg.body.value.points;
          const last = points[points.length - 1];
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'locationAdded',
                value: {
                  deviceUid: 'dev-1',
                  trackUid: msg.body.value.trackUid,
                  point: last,
                  clientSeq: msg.body.value.clientSeq,
                },
              },
            }),
          );
          break;
        }
        case 'subscribe':
          conn.send(
            create(ServerMsgSchema, {
              body: {
                case: 'subscribed',
                value: {
                  deviceUid: msg.body.value.deviceUid,
                  trackUid: 'track-mock-1',
                  route: [],
                  estimatedDistance: 0,
                  estimatedDuration: 0,
                  startLocationName: '',
                  endLocationName: '',
                },
              },
            }),
          );
          break;
        case 'ping':
          conn.send(
            create(ServerMsgSchema, {
              body: { case: 'pong', value: {} },
            }),
          );
          break;
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
  return create(ServerMsgSchema, {
    body: { case: 'error', value: { code, message } },
  });
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
