import { describe, expect, it } from 'vitest';
import { connect } from '@pickpoint/sdk/tracking';
import { startMockTrackingServer } from './helpers/mock-tracking-server';

const auth = { clientId: 'c', clientSecret: 's' };

describe('TrackingClient happy path', () => {
  it('connects, starts track, publishes, stops', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: false,
      });
      expect(client.state).toBe('open');

      const trackUid = await client.startTrack({
        location: { latitude: 55.75, longitude: 37.61 },
      });
      expect(trackUid).toBe('track-mock-1');
      expect(client.trackUid).toBe('track-mock-1');

      const seq = client.publish({ latitude: 55.76, longitude: 37.62 });
      expect(seq).toBe(1n);

      await server.waitForMessage((m) => m.body.case === 'locationAdd');

      await client.stopTrack();
      expect(client.trackUid).toBeUndefined();
      client.close();
    } finally {
      await server.close();
    }
  });

  it('subscribe returns Subscribed snapshot', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: { accessToken: 'tok' },
        reconnect: false,
      });
      const snap = await client.subscribe('device-uid-1');
      expect(snap.deviceUid).toBe('device-uid-1');
      client.close();
    } finally {
      await server.close();
    }
  });
});
