import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, MIN_RETRY_BASE_MS, PickPoint } from '@pickpoint/sdk';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HTTP resources (devices / routing / mint)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('devices 409 → CONFLICT ApiError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, { message: 'device offline' }),
    );
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    await expect(pp.devices.command('u1', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    await expect(pp.devices.command('u1', new Uint8Array([1]))).rejects.toBeInstanceOf(
      ApiError,
    );
    pp.close();
  });

  it('devices.command base64-encodes bytes', async () => {
    const fetchMock = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: string };
      expect(body.payload).toBe(btoa('ping'));
      return jsonResponse(200, { delivered: 1 });
    });
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    const out = await pp.devices.command('uid', new TextEncoder().encode('ping'));
    expect(out.delivered).toBe(1);
    pp.close();
  });

  it('routing 400 with errorCode throws (not empty)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        message: 'Please check request parameters',
        errorCode: 400,
      }),
    );
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    await expect(pp.route({ locations: [] })).rejects.toMatchObject({
      status: 400,
      code: 'CLIENT_ERROR',
    });
    pp.close();
  });

  it('address search 400 throws', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { errorCode: 400 }));
    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });
    await expect(pp.search({ q: 'x' })).rejects.toBeInstanceOf(ApiError);
    pp.close();
  });

  it('client-tokens refresh body shape (mint is server-side)', async () => {
    // Mint lives on the backend; SDK consumes the pair and refreshes it.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/refresh')) {
        const body = JSON.parse(String(init?.body)) as { refreshToken: string };
        expect(body).toEqual({ refreshToken: 'r1' });
        return jsonResponse(200, {
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresAt: 1_700_000_000_000,
          expiresIn: 600,
          scopes: ['geocoding'],
        });
      }
      return jsonResponse(200, []);
    });
    const pp = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'a1',
        refreshToken: 'r1',
        expiresAt: Date.now() + 50,
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    await pp.forward({ q: 'x' });
    pp.close();
  });
});
