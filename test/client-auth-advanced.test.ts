import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiAuthError,
  ApiError,
  MIN_RETRY_BASE_MS,
  PickPoint,
  isBrowserRuntime,
} from '@pickpoint/sdk';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('clientAuth advanced', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('single-flight: N parallel calls with expired TTL → one refresh', async () => {
    let refreshCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/client-tokens/refresh')) {
        refreshCount += 1;
        await delay(40);
        return jsonResponse(200, {
          accessToken: 'access-fresh',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 120_000,
        });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer access-fresh',
      );
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'access-stale',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 80, // half ≈ 40ms
      },
    });

    await delay(50);
    await Promise.all([
      pp.forward({ q: 'a' }),
      pp.forward({ q: 'b' }),
      pp.search({ q: 'c' }),
      pp.devices.list(),
    ]);

    expect(refreshCount).toBe(1);
    pp.close();
  });

  it('refresh token rotation: second client with old refresh fails', async () => {
    let validRefresh = 'refresh-1';
    const mkFetch = () =>
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/refresh')) {
          const body = JSON.parse(String(init?.body)) as { refreshToken: string };
          if (body.refreshToken !== validRefresh) {
            return jsonResponse(401, { message: 'invalid refresh' });
          }
          validRefresh = 'refresh-2';
          return jsonResponse(200, {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: Date.now() + 60_000,
          });
        }
        return jsonResponse(200, [{ ok: true }]);
      });

    const fetchA = mkFetch();
    const a = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchA as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'a1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 50,
      },
    });
    await delay(40);
    await a.forward({ q: 'x' });

    const fetchB = mkFetch();
    const b = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchB as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'b1',
        refreshToken: 'refresh-1', // already rotated
        expiresAt: Date.now() + 50,
      },
    });
    await delay(40);
    await expect(b.forward({ q: 'y' })).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    a.close();
    b.close();
  });

  it('401 after successful refresh does not loop forever', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/refresh')) {
        return jsonResponse(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 60_000,
        });
      }
      n += 1;
      return jsonResponse(401, { message: 'still bad' });
    });

    const pp = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 60_000,
      },
    });

    await expect(pp.forward({ q: 'x' })).rejects.toBeInstanceOf(ApiAuthError);
    // initial + one retry after refresh = 2 geocode calls; 1 refresh
    expect(n).toBe(2);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/refresh'))).toHaveLength(
      1,
    );
    pp.close();
  });

  it('proactive refresh only after 50% TTL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/refresh')) {
        return jsonResponse(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 60_000,
        });
      }
      return jsonResponse(200, []);
    });

    const ttl = 200;
    const pp = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + ttl,
      },
    });

    await pp.forward({ q: 'early' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/refresh'))).toBe(false);

    await delay(ttl * 0.55);
    await pp.forward({ q: 'late' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/refresh'))).toBe(true);
    pp.close();
  });

  it('mixed fan-out shares one 401 refresh', async () => {
    let apiHits = 0;
    let refreshes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/refresh')) {
        refreshes += 1;
        await delay(30);
        return jsonResponse(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 60_000,
        });
      }
      apiHits += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer access-1') {
        return jsonResponse(401, {});
      }
      if (url.includes('/address/search')) {
        return jsonResponse(200, { features: [] });
      }
      if (url.includes('/devices')) {
        return jsonResponse(200, { data: [], total: 0 });
      }
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = new PickPoint({
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      retryBaseMs: MIN_RETRY_BASE_MS,
      clientAuth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 60_000,
      },
    });

    await Promise.all([
      pp.forward({ q: 'a' }),
      pp.search({ q: 'b' }),
      pp.devices.list(),
    ]);
    expect(refreshes).toBe(1);
    expect(apiHits).toBeGreaterThanOrEqual(4); // 3×401 + retries
    pp.close();
  });

  it('clientAuth works in browser runtime (apiKey still blocked)', () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    const prevDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = {};
    try {
      expect(isBrowserRuntime()).toBe(true);
      expect(
        () =>
          new PickPoint({
            apiKey: 'secret',
            baseUrl: 'https://api.test',
          }),
      ).toThrow(ApiError);

      const pp = new PickPoint({
        baseUrl: 'https://api.test',
        fetch: (async () => jsonResponse(200, [])) as typeof fetch,
        clientAuth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: Date.now() + 60_000,
        },
      });
      pp.close();
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prevWindow;
      }
      if (prevDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = prevDocument;
      }
    }
  });
});
