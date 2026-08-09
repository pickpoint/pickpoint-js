import { authHeaders, type ResolvedAuth } from './auth.js';
import { ApiAuthError, ApiError } from './errors.js';
import type { HttpTransport } from './http.js';

export type RequestJsonOpts<T> = {
  transport: HttpTransport;
  auth: ResolvedAuth;
  url: string;
  method?: string;
  body?: unknown;
  maxRetries: number;
  retryBaseMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * `throw` (default) — non-auth 4xx becomes ApiError.
   * `empty` — return `empty()` for non-auth 4xx (geocoding batch slots).
   */
  onClientError?: 'throw' | 'empty';
  empty?: () => T;
  parse?: (body: unknown, res: Response) => T;
  /** Treat 204 as success with this value (default undefined). */
  noContent?: () => T;
};

export async function requestJson<T = unknown>(opts: RequestJsonOpts<T>): Promise<T> {
  const onClientError = opts.onClientError ?? 'throw';
  let attempt = 0;
  let authRetried = false;
  const parentSignal = opts.signal;

  const refreshAuth =
    opts.auth.kind === 'bearer'
      ? () => opts.auth.kind === 'bearer' && opts.auth.session.refreshAfterUnauthorized()
      : undefined;

  for (;;) {
    if (parentSignal?.aborted) {
      throw new ApiError('request aborted', { code: 'ABORTED', cause: parentSignal.reason });
    }

    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = parentSignal ? anySignal([parentSignal, timeout]) : timeout;

    try {
      const headers = await authHeaders(opts.auth);
      const init: RequestInit = {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers,
        signal,
      };
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }

      const res = await opts.transport.fetch(opts.url, init);

      if (res.status === 401) {
        if (!authRetried && refreshAuth) {
          const refreshed = await refreshAuth();
          if (refreshed) {
            authRetried = true;
            continue;
          }
        }
        throw new ApiAuthError(`auth failed (${res.status})`, res.status);
      }
      if (res.status === 402 || res.status === 403) {
        throw new ApiAuthError(`auth failed (${res.status})`, res.status);
      }

      if (res.status === 204) {
        return (opts.noContent ? opts.noContent() : undefined) as T;
      }

      if (res.status === 400 || (res.status >= 404 && res.status < 500)) {
        if (onClientError === 'empty') {
          return (opts.empty ? opts.empty() : undefined) as T;
        }
        const body = await readBody(res);
        throw new ApiError(messageFromBody(body, `request failed (${res.status})`), {
          status: res.status,
          code: res.status === 404 ? 'NOT_FOUND' : 'CLIENT_ERROR',
          body,
        });
      }

      if (res.status === 409) {
        const body = await readBody(res);
        throw new ApiError(messageFromBody(body, `conflict (${res.status})`), {
          status: 409,
          code: 'CONFLICT',
          body,
        });
      }

      if (res.status >= 500) {
        if (attempt >= opts.maxRetries) {
          throw new ApiError(`server error (${res.status}) after retries`, {
            status: res.status,
            code: 'SERVER_ERROR',
          });
        }
        await sleep(backoffMs(opts.retryBaseMs, attempt));
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          if (onClientError === 'empty') {
            return (opts.empty ? opts.empty() : undefined) as T;
          }
          const body = await readBody(res);
          throw new ApiError(messageFromBody(body, `request failed (${res.status})`), {
            status: res.status,
            code: 'CLIENT_ERROR',
            body,
          });
        }
        throw new ApiError(`request failed (${res.status})`, { status: res.status });
      }

      const body = await readBody(res);
      return opts.parse ? opts.parse(body, res) : (body as T);
    } catch (err) {
      if (err instanceof ApiAuthError || err instanceof ApiError) {
        throw err;
      }
      if (parentSignal?.aborted) {
        throw new ApiError('request aborted', { code: 'ABORTED', cause: err });
      }
      if (!isRetryableNetwork(err) || attempt >= opts.maxRetries) {
        throw new ApiError('network error', {
          code: 'NETWORK',
          cause: err,
        });
      }
      await sleep(backoffMs(opts.retryBaseMs, attempt));
      attempt += 1;
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message) {
      return o.message;
    }
    if (typeof o.error === 'string' && o.error) {
      return o.error;
    }
  }
  return fallback;
}

function isRetryableNetwork(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  if (err && typeof err === 'object') {
    const e = err as { name?: string; code?: string; message?: string };
    if (e.name === 'AbortError' && e.message?.includes('timeout')) {
      return true;
    }
    if (e.name === 'TimeoutError') {
      return true;
    }
    const code = e.code ?? '';
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'UND_ERR_SOCKET'
    ) {
      return true;
    }
    if (typeof e.message === 'string' && /fetch failed|network/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

function backoffMs(base: number, attempt: number): number {
  const exp = base * 2 ** attempt;
  return Math.floor(Math.random() * exp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export function toQuery(
  input: Record<string, string | number | boolean | undefined | null>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) {
      continue;
    }
    if (typeof v === 'boolean') {
      params.set(k, v ? '1' : '0');
    } else {
      params.set(k, String(v));
    }
  }
  return params.toString();
}
