import { describe, expect, it } from 'vitest';
import { buildWsUrl, TRACKING_SUBPROTOCOL } from '@pickpoint/sdk/tracking';

describe('buildWsUrl', () => {
  it('maps https → wss and attaches device auth', () => {
    const url = buildWsUrl('https://tracking.example.com', {
      clientId: 'id',
      clientSecret: 'sec',
    });
    const u = new URL(url);
    expect(u.protocol).toBe('wss:');
    expect(u.pathname).toBe('/v2/ws');
    expect(u.searchParams.get('client-id')).toBe('id');
    expect(u.searchParams.get('client-secret')).toBe('sec');
  });

  it('attaches listener access-token', () => {
    const url = buildWsUrl('ws://localhost:1', { accessToken: 'jwt' });
    expect(new URL(url).searchParams.get('access-token')).toBe('jwt');
  });

  it('uses tracking.v2 subprotocol', () => {
    expect(TRACKING_SUBPROTOCOL).toBe('tracking.v2');
  });
});
