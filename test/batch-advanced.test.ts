import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, MIN_RETRY_BASE_MS, PickPoint } from '@pickpoint/sdk';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('geocode batch advanced', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('403 aborts batch; remaining slots cancelled', async () => {
    let hits = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      hits += 1;
      const url = String(input);
      if (url.includes('q=bad')) {
        return jsonResponse(403, { message: 'forbidden' });
      }
      await new Promise((r) => setTimeout(r, 80));
      return jsonResponse(200, [{ q: 'ok' }]);
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      concurrency: 4,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    await expect(
      pp.forward([
        { q: 'bad' },
        { q: 'a' },
        { q: 'b' },
        { q: 'c' },
        { q: 'd' },
        { q: 'e' },
      ]),
    ).rejects.toBeInstanceOf(ApiAuthError);

    // Not all 6 should complete successfully; abort should cut work short.
    expect(hits).toBeLessThan(6);
    pp.close();
  });

  it('pipeline fills a free slot without waiting for the whole wave', async () => {
    const started = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const q = new URL(String(input)).searchParams.get('q') ?? '';
      started.set(q, Date.now());
      if (q === 'slow') {
        await new Promise((r) => setTimeout(r, 80));
      } else {
        await new Promise((r) => setTimeout(r, 5));
      }
      return jsonResponse(200, [{ q }]);
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      concurrency: 2,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    await pp.forward([{ q: 'slow' }, { q: 'a' }, { q: 'b' }, { q: 'c' }]);
    const aAt = started.get('a')!;
    const bAt = started.get('b')!;
    const slowAt = started.get('slow')!;
    // Pipeline: "b" starts soon after "a" frees a slot, overlapping "slow".
    expect(bAt - aAt).toBeLessThan(40);
    expect(bAt).toBeLessThan(slowAt + 60);
    pp.close();
  });

  it('preserves slot order with slow first and fast last', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('q=slow')) {
        await new Promise((r) => setTimeout(r, 60));
        return jsonResponse(200, [{ id: 'slow' }]);
      }
      return jsonResponse(200, [{ id: 'fast' }]);
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      concurrency: 10,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    const out = await pp.forward([
      { q: 'slow' },
      { q: 'fast1' },
      { q: 'fast2' },
    ]);
    expect(out[0]).toEqual([{ id: 'slow' }]);
    expect(out[1]).toEqual([{ id: 'fast' }]);
    expect(out[2]).toEqual([{ id: 'fast' }]);
    pp.close();
  });

  it('retry budget per slot on 503', async () => {
    const attemptsByQ = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const q = url.searchParams.get('q') ?? '';
      const n = (attemptsByQ.get(q) ?? 0) + 1;
      attemptsByQ.set(q, n);
      if (q === 'flaky' && n < 3) {
        return jsonResponse(503, {});
      }
      return jsonResponse(200, [{ q }]);
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 5,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    const out = await pp.forward([{ q: 'flaky' }, { q: 'ok' }]);
    expect(out[0]).toEqual([{ q: 'flaky' }]);
    expect(out[1]).toEqual([{ q: 'ok' }]);
    expect(attemptsByQ.get('flaky')).toBe(3);
    expect(attemptsByQ.get('ok')).toBe(1);
    pp.close();
  });

  it('per-attempt timeout retries then succeeds', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      if (n === 1) {
        // hang until aborted by timeout
        await new Promise<void>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
        });
      }
      return jsonResponse(200, [{ ok: true }]);
    });

    const pp = new PickPoint({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 40,
      maxRetries: 2,
      retryBaseMs: MIN_RETRY_BASE_MS,
    });

    const out = await pp.forward({ q: 'x' });
    expect(out).toEqual([{ ok: true }]);
    expect(n).toBe(2);
    pp.close();
  });
});
