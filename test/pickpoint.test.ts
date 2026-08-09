import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, MIN_RETRY_BASE_MS, PickPoint } from '@pickpoint/sdk';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PickPoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares auth across namespaces and flat shortcuts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/geocode/forward')) {
        return jsonResponse(200, [{ display_name: 'Berlin' }]);
      }
      if (url.includes('/address/search')) {
        return jsonResponse(200, { type: 'FeatureCollection', features: [] });
      }
      if (url.includes('/v2/route') && !url.includes('optimized')) {
        return jsonResponse(200, { trip: { legs: [] } });
      }
      if (url.includes('/v2/devices') && !url.includes('/command')) {
        return jsonResponse(200, { data: [{ uid: 'd1', name: 'A', type: 'car' }], total: 1 });
      }
      return jsonResponse(404, { message: 'nope' });
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    const places = await pp.forward({ q: 'Berlin' });
    expect(places).toHaveLength(1);

    const { search, route } = pp;
    await search({ q: 'Berlin' });
    await route({ locations: [] });
    const devices = await pp.devices.list();
    expect(devices.total).toBe(1);

    for (const call of fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>) {
      expect(call[1].headers).toMatchObject({ 'x-api-key': 'k' });
    }
    pp.close();
  });

  it('destructured forward keeps working (bound arrows)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, [{ ok: true }]));
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    const { forward } = pp;
    await forward({ q: 'x' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('devices.command base64-encodes Uint8Array', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/devices/uid-1/command');
      const body = JSON.parse(String(init?.body)) as { payload: string };
      expect(body.payload).toBe(Buffer.from('hi').toString('base64'));
      return jsonResponse(200, { delivered: 1 });
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    const out = await pp.devices.command('uid-1', new TextEncoder().encode('hi'));
    expect(out.delivered).toBe(1);
  });

  it('throws ApiError on devices 404', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: 'Device not found' }));
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    await expect(pp.devices.get('missing')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(pp.devices.get('missing')).rejects.toBeInstanceOf(ApiError);
  });

  it('clientAuth 401 refresh is shared (single session)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/client-tokens/refresh')) {
        return jsonResponse(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 60_000,
        });
      }
      n += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (n === 1) {
        expect(auth).toBe('Bearer access-1');
        return jsonResponse(401, { message: 'expired' });
      }
      expect(auth).toBe('Bearer access-2');
      if (url.includes('/address/search')) {
        return jsonResponse(200, { features: [] });
      }
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = new PickPoint({
      clientAuth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 60_000,
      },
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    await pp.forward({ q: 'a' });
    await pp.search({ q: 'b' });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/refresh'))).toHaveLength(1);
  });

  it('maps 403 to ApiAuthError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { message: 'nope' }));
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    await expect(pp.route({})).rejects.toBeInstanceOf(ApiAuthError);
  });
});
