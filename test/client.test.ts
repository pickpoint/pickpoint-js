import { describe, expect, it } from 'vitest';
import { connect } from '@pickpoint/sdk/tracking';
import {
  MOCK_TRACK_UID,
  startMockTrackingServer,
} from './helpers/mock-tracking-server';

const auth = { clientId: 'c', clientSecret: 's' };
const DEVICE_UID = '22222222-2222-2222-2222-222222222222';

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
      expect(trackUid).toBe(MOCK_TRACK_UID);
      expect(client.trackUid).toBe(MOCK_TRACK_UID);

      const seq = client.publish({ latitude: 55.76, longitude: 37.62 });
      expect(seq).toBe(1n);

      await server.waitForMessage((m) => m.type === 'loc');

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
      const snap = await client.subscribe(DEVICE_UID);
      expect(snap.deviceUid).toBe(DEVICE_UID);
      expect(snap.sub).toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('first publish starts the track; close stops it', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth,
        reconnect: false,
      });
      client.publish({ latitude: 55.75, longitude: 37.61 });
      await server.waitForMessage((m) => m.type === 'trackStart');
      client.close();
      await server.waitForMessage((m) => m.type === 'trackStop');
    } finally {
      await server.close();
    }
  });

  it('subscribe on connect watches the device', async () => {
    const server = await startMockTrackingServer();
    try {
      const client = await connect({
        endpoint: server.origin,
        auth: { accessToken: 'tok' },
        reconnect: false,
        subscribe: DEVICE_UID,
      });
      await server.waitForMessage((m) => m.type === 'subscribe');
      client.close();
    } finally {
      await server.close();
    }
  });
});
