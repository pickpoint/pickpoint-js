import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientMsgSchema,
  ErrorCode,
  MAX_EVENT_BYTES,
  MAX_PUBLISH_HZ,
  ServerMsgSchema,
  TrackingSdkError,
  clientResume,
  connect,
  encodeClientMsg,
} from '@pickpoint/sdk/tracking';
import {
  serverError,
  startMockTrackingServer,
} from './helpers/mock-tracking-server';

const deviceAuth = { clientId: 'c', clientSecret: 's' };
const MIN_GAP_MS = Math.ceil(1000 / MAX_PUBLISH_HZ);

describe('tracking advanced', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publish drops above 50 Hz (no seq bump / no wire flood)', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: deviceAuth,
        reconnect: false,
      });
      await client.startTrack();

      let accepted = 0;
      for (let i = 0; i < MAX_PUBLISH_HZ * 3; i++) {
        const before = client.clientSeq;
        const seq = client.publish({ latitude: i, longitude: 0 });
        if (seq > before) {
          accepted += 1;
        }
      }
      expect(accepted).toBe(1);
      expect(client.clientSeq).toBe(1n);

      await new Promise((r) => setTimeout(r, MIN_GAP_MS + 5));
      expect(client.publish({ latitude: 1, longitude: 1 })).toBe(2n);

      client.close();
    } finally {
      await server.close();
    }
  });

  it('sendEvent enforces 4 KiB and 1 Hz', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: deviceAuth,
        reconnect: false,
      });
      await client.startTrack();

      expect(() => client.sendEvent(new Uint8Array(MAX_EVENT_BYTES + 1))).toThrow(
        TrackingSdkError,
      );

      expect(client.sendEvent(new TextEncoder().encode('a'))).toBe(true);
      expect(client.sendEvent(new TextEncoder().encode('b'))).toBe(false);

      await server.waitForMessage((m) => m.body.case === 'event');
      client.close();
    } finally {
      await server.close();
    }
  });

  it('AUTH error without refreshAuth closes the client', async () => {
    const server = await startMockTrackingServer({
      auto: false,
      onClientMsg(msg, ctx) {
        if (msg.body.case === 'trackStart') {
          ctx.send(serverError(ErrorCode.AUTH, 'bad creds'));
        }
      },
    });
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: deviceAuth,
        reconnect: { minDelayMs: 10, maxDelayMs: 20 },
      });
      await expect(client.startTrack()).rejects.toBeInstanceOf(TrackingSdkError);
      await waitFor(() => client.state === 'closed', 3_000);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('AUTH error calls refreshAuth and redials', async () => {
    let hellos = 0;
    let refreshDone!: () => void;
    const refreshSaw = new Promise<void>((r) => {
      refreshDone = r;
    });
    const refreshAuth = vi.fn(async () => {
      refreshDone();
      return { clientId: 'c2', clientSecret: 's2' };
    });

    const server = await startMockTrackingServer({
      auto: false,
      beforeHello() {
        hellos += 1;
      },
      onClientMsg(msg, ctx) {
        if (msg.body.case === 'trackStart') {
          ctx.send(serverError(ErrorCode.UNAUTHORIZED, 'expired'));
        }
      },
    });
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: deviceAuth,
        refreshAuth,
        reconnect: { minDelayMs: 15, maxDelayMs: 40 },
        helloTimeoutMs: 2_000,
      });

      void client.startTrack().catch(() => {});
      await Promise.race([
        refreshSaw,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('refreshAuth not called')), 3_000),
        ),
      ]);
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      await waitFor(() => hellos >= 2, 5_000);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('listener subscribe then receives location fan-out', async () => {
    const server = await startMockTrackingServer({
      auto: true,
      onClientMsg(msg, ctx) {
        if (msg.body.case !== 'subscribe') {
          return;
        }
        const deviceUid = msg.body.value.deviceUid;
        setTimeout(() => {
          ctx.send(
            create(ServerMsgSchema, {
              body: {
                case: 'locationAdded',
                value: {
                  deviceUid,
                  trackUid: 't1',
                  clientSeq: 3n,
                  point: {
                    latitude: 1.5,
                    longitude: 2.5,
                    timestampMs: 1n,
                  },
                },
              },
            }),
          );
        }, 20);
      },
    });
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: { accessToken: 'listener-jwt' },
        reconnect: false,
      });

      const locP = new Promise<{ latitude: number; longitude: number }>((resolve) => {
        client.on('location', (m) => {
          resolve({
            latitude: m.point?.latitude ?? 0,
            longitude: m.point?.longitude ?? 0,
          });
        });
      });

      await client.subscribe('device-1');
      await expect(locP).resolves.toEqual({ latitude: 1.5, longitude: 2.5 });
      client.close();
    } finally {
      await server.close();
    }
  });

  it('golden wire: resume ClientMsg binary is stable', () => {
    const msg = clientResume('track-uid-9', 42n);
    const bytes = encodeClientMsg(msg);
    const round = fromBinary(ClientMsgSchema, bytes);
    expect(round.body.case).toBe('resume');
    if (round.body.case === 'resume') {
      expect(round.body.value.trackUid).toBe('track-uid-9');
      expect(round.body.value.lastClientSeq).toBe(42n);
    }
    expect(Buffer.from(bytes).toString('hex')).toBe(
      Buffer.from(toBinary(ClientMsgSchema, msg)).toString('hex'),
    );
    expect(Buffer.from(bytes).toString('hex')).toBe(
      '0a0f0a0b747261636b2d7569642d39102a',
    );
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}
