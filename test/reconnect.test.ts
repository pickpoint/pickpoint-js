import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ErrorCode, ServerMsgSchema } from '../src/gen/tracking/v2/messages_pb.js';
import { connect } from '../src/tracking/client.js';
import {
  serverError,
  startMockTrackingServer,
} from './helpers/mock-tracking-server.js';

const auth = { clientId: 'c', clientSecret: 's' };

describe('reconnect / resume', () => {
  it('after drop, sends resume (not track_start) with clientSeq', async () => {
    const server = await startMockTrackingServer({
      auto: true,
    });
    try {
      const client = await connect({
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
      // Drop TCP / WS without client.close()
      first.close(4001, 'simulated drop');

      // Wait for second connection + resume
      const resumeMsg = await server.waitForMessage(
        (m) => m.body.case === 'resume',
        8_000,
      );
      expect(resumeMsg.body.case).toBe('resume');
      if (resumeMsg.body.case === 'resume') {
        expect(resumeMsg.body.value.trackUid).toBe(trackUid);
        expect(resumeMsg.body.value.lastClientSeq).toBe(2n);
      }

      // Must not have started a new track on reconnect
      const trackStarts = server.connections
        .flatMap((c) => c.messages)
        .filter((m) => m.body.case === 'trackStart');
      expect(trackStarts).toHaveLength(1);

      // Wait until open again
      await waitFor(() => client.state === 'open', 5_000);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('TRACK_NOT_FOUND clears cursor and rejects resume', async () => {
    const server = await startMockTrackingServer({
      auto: false,
      onClientMsg(msg, ctx) {
        if (msg.body.case === 'trackStart') {
          ctx.send(
            create(ServerMsgSchema, {
              body: {
                case: 'trackStarted',
                value: { trackUid: 't-gone' },
              },
            }),
          );
        }
        if (msg.body.case === 'resume') {
          ctx.send(
            serverError(ErrorCode.TRACK_NOT_FOUND, 'track expired'),
          );
        }
      },
    });
    // Still need Hello — auto:false skips handlers but Hello is always sent.
    // We need Hello + custom handlers. Our mock always sends Hello unless relocate.
    // For trackStart we handle above. For location etc. noop.

    // Patch: first connection hello is automatic. Good.
    try {
      // Re-enable hello-only auto path: server always sends hello.
      const client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: { minDelayMs: 20, maxDelayMs: 40 },
      });

      // With auto:false, trackStart won't get response unless onClientMsg handles it — we did.
      await client.startTrack();
      expect(client.trackUid).toBe('t-gone');

      const conn = await server.waitForConnection();
      conn.close(4001, 'drop');

      await server.waitForMessage((m) => m.body.case === 'resume', 8_000);

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
      // After relocate, client should be talking to target (Hello there).
      expect(client.state).toBe('open');
      expect(target.connections.length).toBeGreaterThanOrEqual(1);

      const trackUid = await client.startTrack();
      expect(trackUid).toBe('track-mock-1');
      client.close();
    } finally {
      await gateway.close();
      await target.close();
    }
  });

  it('queues publishes while reconnecting and flushes after resumeOk', async () => {
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
      // Hold second Hello until the offline point is queued.
      const seq = client.publish({ latitude: 9, longitude: 9 });
      expect(seq).toBe(1n);
      releaseSecondHello();

      await server.waitForMessage((m) => m.body.case === 'resume', 8_000);
      await server.waitForMessage(
        (m) => m.body.case === 'locationBatch' || m.body.case === 'locationAdd',
        8_000,
      );
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
