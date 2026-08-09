import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiAuthError,
  ApiError,
  MAX_CONCURRENCY,
  MIN_RETRY_BASE_MS,
  PickPoint,
  SOFT_BATCH_WARN,
  isBrowserRuntime,
  resolveAuth,
} from '@pickpoint/sdk';

const authDeps = {
  baseUrl: 'https://api.test',
  fetch: globalThis.fetch.bind(globalThis),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(opts: ConstructorParameters<typeof PickPoint>[0]) {
  return new PickPoint({
    baseUrl: 'https://api.test',
    retryBaseMs: MIN_RETRY_BASE_MS,
    ...opts,
  });
}

describe('geocoding via PickPoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forward single and reverse single', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/forward')) {
        return jsonResponse(200, [{ display_name: 'Berlin', lat: '52.5', lon: '13.4' }]);
      }
      return jsonResponse(200, { display_name: 'Somewhere', lat: '1', lon: '2' });
    });

    const pp = client({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const f = await pp.forward({ q: 'Berlin' });
    expect(f).toHaveLength(1);
    const [url0, init0] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url0).toContain('q=Berlin');
    expect(init0.headers).toMatchObject({ 'x-api-key': 'k' });

    const r = await pp.reverse({ lat: 1, lon: 2 });
    expect(r).toMatchObject({ display_name: 'Somewhere' });
    pp.close();
  });

  it('getAccessToken sends Authorization Bearer', async () => {
    const getter = vi.fn(async () => 'tok-123');
    const fetchMock = vi.fn(async () => jsonResponse(200, [{ ok: true }]));
    const pp = client({
      getAccessToken: getter,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await pp.forward({ q: 'x' });
    expect(getter).toHaveBeenCalledWith({ reason: 'initial' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
  });

  it('refreshes on 401 once then retries', async () => {
    let n = 0;
    const getter = vi.fn(async ({ reason }: { reason: string }) => {
      if (reason === 'unauthorized') {
        return 'tok-fresh';
      }
      return 'tok-stale';
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (n === 1) {
        expect(auth).toBe('Bearer tok-stale');
        return jsonResponse(401, { message: 'expired' });
      }
      expect(auth).toBe('Bearer tok-fresh');
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = client({
      getAccessToken: getter,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = await pp.forward({ q: 'x' });
    expect(out).toEqual([{ ok: true }]);
    expect(getter).toHaveBeenCalledWith({ reason: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches token until expiresAt then refreshes', async () => {
    const getter = vi.fn(async () => ({
      accessToken: `t-${getter.mock.calls.length}`,
      expiresAt: Date.now() + 60_000,
    }));
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    const pp = client({
      getAccessToken: getter,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await pp.forward({ q: 'a' });
    await pp.forward({ q: 'b' });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('rejects apiKey in browser runtime', () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    const prevDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = {};
    try {
      expect(isBrowserRuntime()).toBe(true);
      expect(() => resolveAuth({ apiKey: 'secret' }, authDeps)).toThrow(ApiError);
      try {
        resolveAuth({ apiKey: 'secret' }, authDeps);
      } catch (e) {
        expect((e as ApiError).code).toBe('API_KEY_IN_BROWSER');
      }
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

  it('rejects mixing apiKey and getAccessToken', () => {
    expect(() =>
      resolveAuth({ apiKey: 'k', getAccessToken: async () => 't' }, authDeps),
    ).toThrow(/only one of/);
  });

  it('clientAuth refreshes at halfway TTL via /v2/client-tokens/refresh', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/client-tokens/refresh')) {
        return jsonResponse(200, {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: Date.now() + 120_000,
        });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      expect(auth).toBe('Bearer access-2');
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = client({
      clientAuth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 100,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await new Promise((r) => setTimeout(r, 60));
    await pp.forward({ q: 'x' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/refresh'))).toBe(true);
  });

  it('array overload and batch.forward share path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, [{ lat: '0', lon: '0' }]));
    const pp = client({
      apiKey: 'k',
      concurrency: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const a = await pp.forward([{ q: 'a' }, { q: 'b' }]);
    const b = await pp.geocoding.batch.forward([{ q: 'c' }]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caps concurrency at MAX_CONCURRENCY', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchMock = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return jsonResponse(200, []);
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pp = client({
      apiKey: 'k',
      concurrency: 100,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await pp.forward(Array.from({ length: 40 }, (_, i) => ({ q: String(i) })));
    expect(maxInflight).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamping'));
  });

  it('retries on 500 then succeeds', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n < 3) {
        return jsonResponse(503, { error: 'busy' });
      }
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = client({
      apiKey: 'k',
      maxRetries: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = await pp.forward({ q: 'x' });
    expect(out).toEqual([{ ok: true }]);
    expect(n).toBe(3);
  });

  it('400 yields empty slot; batch continues', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('q=bad')) {
        return jsonResponse(400, { message: 'bad' });
      }
      return jsonResponse(200, [{ q: 'good' }]);
    });

    const pp = client({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = await pp.geocoding.batch.forward([{ q: 'bad' }, { q: 'good' }]);
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([{ q: 'good' }]);
  });

  it('401 aborts batch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { message: 'nope' }));
    const pp = client({
      apiKey: 'bad',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      pp.geocoding.batch.reverse([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]),
    ).rejects.toBeInstanceOf(ApiAuthError);
  });

  it('warns on huge batch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pp = client({
      apiKey: 'k',
      concurrency: 20,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const inputs = Array.from({ length: SOFT_BATCH_WARN }, () => ({ q: 'x' }));
    await pp.forward(inputs.slice(0, SOFT_BATCH_WARN));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(SOFT_BATCH_WARN)));
  }, 60_000);
});
