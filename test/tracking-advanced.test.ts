import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  MAX_EVENT_BYTES,
  MAX_PUBLISH_HZ,
  TrackingSdkError,
  bytesToHex,
  clientResume,
  connect,
  encodeClientMsg,
  isFatalResumeError,
} from '@pickpoint/sdk/tracking';
import {
  serverError,
  startMockTrackingServer,
} from './helpers/mock-tracking-server';

const deviceAuth = { clientId: 'c', clientSecret: 's' };
const DEVICE_UID = '22222222-2222-2222-2222-222222222222';
const MIN_GAP_MS = Math.ceil(1000 / MAX_PUBLISH_HZ);

describe('tracking advanced', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isFatalResumeError is AUTH and TRACK_NOT_FOUND only', () => {
    expect(isFatalResumeError(ErrorCode.TRACK_NOT_FOUND)).toBe(true);
    expect(isFatalResumeError(ErrorCode.AUTH)).toBe(true);
    expect(isFatalResumeError(ErrorCode.FENCED)).toBe(false);
    expect(isFatalResumeError(ErrorCode.TRY_AGAIN)).toBe(false);
    expect(isFatalResumeError(ErrorCode.UNAUTHORIZED)).toBe(false);
  });

  it('publish drops above 50 Hz (no seq bump / no wire flood)', async () => {
    const server = await startMockTrackingServer();
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      client = await connect({
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
    } finally {
      client?.close();
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

      await server.waitForMessage((m) => m.type === 'event');
      client.close();
    } finally {
      await server.close();
    }
  });

  it('AUTH error without refreshAuth closes the client', async () => {
    const server = await startMockTrackingServer({
      auto: false,
      onClientMsg(msg, ctx) {
        if (msg.type === 'trackStart') {
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
        if (msg.type === 'trackStart') {
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

  it('listener subscribe then receives location fan-out (not Ack)', async () => {
    const server = await startMockTrackingServer({
      auto: true,
      onClientMsg(msg, ctx) {
        if (msg.type !== 'subscribe') {
          return;
        }
        setTimeout(() => {
          ctx.send({
            type: 'loc',
            sub: 1,
            seq: 3,
            point: {
              latitude: 1.5,
              longitude: 2.5,
              timestampMs: 1,
            },
          });
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

      await client.subscribe(DEVICE_UID);
      await expect(locP).resolves.toEqual({ latitude: 1.5, longitude: 2.5 });
      client.close();
    } finally {
      await server.close();
    }
  });

  it('device Ack is not emitted as location', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: deviceAuth,
        reconnect: false,
      });
      const locations: unknown[] = [];
      client.on('location', (m) => locations.push(m));
      await client.startTrack();
      client.publish({ latitude: 55, longitude: 37 });
      await server.waitForMessage((m) => m.type === 'loc');
      await new Promise((r) => setTimeout(r, 40));
      expect(locations).toEqual([]);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('resume encoder matches tracking.v2 golden', () => {
    const bytes = encodeClientMsg(
      clientResume('00112233-4455-6677-8899-aabbccddeeff', 45),
    );
    expect(bytesToHex(bytes)).toBe('0100112233445566778899aabbccddeeff2d000000');
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
