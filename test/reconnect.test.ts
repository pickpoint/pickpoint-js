import { describe, expect, it } from 'vitest';
import { ErrorCode, connect } from '@pickpoint/sdk/tracking';
import {
  MOCK_TRACK_UID,
  serverError,
  startMockTrackingServer,
} from './helpers/mock-tracking-server';

const auth = { clientId: 'c', clientSecret: 's' };
const T_GONE = '44444444-4444-4444-4444-444444444444';

describe('reconnect / resume', () => {
  it('after drop, sends resume (not track_start) with last assigned seq', async () => {
    const server = await startMockTrackingServer({
      auto: true,
    });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: { minDelayMs: 20, maxDelayMs: 50 },
      });

      const trackUid = await client.startTrack();
      client.publish({ latitude: 1, longitude: 2 });
      await new Promise((r) => setTimeout(r, 25));
      client.publish({ latitude: 3, longitude: 4 });
      expect(client.clientSeq).toBe(2n);

      const first = await server.waitForConnection();
      first.close(4001, 'simulated drop');

      const resumeMsg = await server.waitForMessage(
        (m) => m.type === 'resume',
        8_000,
      );
      expect(resumeMsg.type).toBe('resume');
      if (resumeMsg.type === 'resume') {
        expect(resumeMsg.trackUid).toBe(trackUid);
        expect(resumeMsg.lastSeq).toBe(2);
      }

      const trackStarts = server.connections
        .flatMap((c) => c.messages)
        .filter((m) => m.type === 'trackStart');
      expect(trackStarts).toHaveLength(1);

      await waitFor(() => client!.state === 'open', 5_000);
    } finally {
      client?.close();
      await server.close();
    }
  });

  it('TRACK_NOT_FOUND clears cursor and rejects resume', async () => {
    const server = await startMockTrackingServer({
      auto: false,
      onClientMsg(msg, ctx) {
        if (msg.type === 'trackStart') {
          ctx.send({
            type: 'trackStarted',
            trackUid: T_GONE,
            metadata: new Uint8Array(),
          });
        }
        if (msg.type === 'resume') {
          ctx.send(serverError(ErrorCode.TRACK_NOT_FOUND, 'track expired'));
        }
      },
    });

    try {
      const client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: { minDelayMs: 20, maxDelayMs: 40 },
      });

      await client.startTrack();
      expect(client.trackUid).toBe(T_GONE);

      const conn = await server.waitForConnection();
      conn.close(4001, 'drop');

      await server.waitForMessage((m) => m.type === 'resume', 8_000);

      await waitFor(() => client.trackUid === undefined, 5_000);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('RELOCATE dials the new endpoint', async () => {
    const target = await startMockTrackingServer();
    const gateway = await startMockTrackingServer({
      relocateOnConnect: {
        endpoint: target.origin,
        retryAfterMs: 10,
      },
      auto: false,
    });
    try {
      const client = await connect({
        endpoint: gateway.origin,
        auth,
        reconnect: false,
      });
      expect(client.state).toBe('open');
      expect(target.connections.length).toBeGreaterThanOrEqual(1);

      const trackUid = await client.startTrack();
      expect(trackUid).toBe(MOCK_TRACK_UID);
      client.close();
    } finally {
      await gateway.close();
      await target.close();
    }
  });

  it('stages publishes while reconnecting and flushes after resumeOk', async () => {
    let releaseSecondHello!: () => void;
    const secondHelloGate = new Promise<void>((r) => {
      releaseSecondHello = r;
    });

    const server = await startMockTrackingServer({
      beforeHello: async (index) => {
        if (index >= 2) {
          await secondHelloGate;
        }
      },
    });
    try {
      const client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: { minDelayMs: 20, maxDelayMs: 50 },
      });
      await client.startTrack();
      const conn = await server.waitForConnection();
      conn.close(4001, 'drop');

      await waitFor(() => client.state === 'reconnecting', 3_000);
      // Offline: filter emits, Staging only — seq is not assigned yet.
      const seq = client.publish({ latitude: 9, longitude: 9 });
      expect(seq).toBe(0n);
      releaseSecondHello();

      await server.waitForMessage((m) => m.type === 'resume', 8_000);
      await server.waitForMessage((m) => m.type === 'loc', 8_000);
      await waitFor(() => client.clientSeq === 1n, 5_000);
      client.close();
    } finally {
      await server.close();
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
