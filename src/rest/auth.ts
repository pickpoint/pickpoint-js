import { ApiError } from './errors.js';
import type {
  AccessTokenResult,
  ClientAuth,
  GetAccessTokenContext,
  RestClientConfig,
} from './types.js';

/** Legacy skew when using getAccessToken without issuedAt (ms). */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** Refresh when this fraction of access TTL has elapsed (0.5 = halfway). */
export const CLIENT_AUTH_REFRESH_AT = 0.5;

export type ResolvedAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'bearer'; session: TokenSession };

export type TokenSession = {
  getToken: (ctx?: GetAccessTokenContext) => Promise<string>;
  refreshAfterUnauthorized: () => Promise<boolean>;
};

/** True in browser / worker-with-window environments (not Node). */
export function isBrowserRuntime(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { document?: unknown }).document !== 'undefined'
  );
}

/**
 * Resolve auth mode. Secret `apiKey` is rejected in browsers.
 * Prefer `clientAuth` (access + refresh pair from your backend).
 */
export function resolveAuth(
  config: RestClientConfig,
  deps: { baseUrl: string; fetch: typeof globalThis.fetch },
): ResolvedAuth {
  const hasKey = typeof config.apiKey === 'string' && config.apiKey.length > 0;
  const hasClient = !!config.clientAuth;
  const hasStatic = typeof config.accessToken === 'string' && config.accessToken.length > 0;
  const hasGetter = typeof config.getAccessToken === 'function';

  const modes = [hasKey, hasClient, hasStatic, hasGetter].filter(Boolean).length;
  if (modes > 1) {
    throw new ApiError(
      'Provide only one of: apiKey | clientAuth | accessToken | getAccessToken',
      { code: 'INVALID_CONFIG' },
    );
  }
  if (modes === 0) {
    throw new ApiError(
      'Auth required: clientAuth (recommended for SPAs), apiKey (Node only), or getAccessToken / accessToken',
      { code: 'INVALID_CONFIG' },
    );
  }

  if (hasKey) {
    if (isBrowserRuntime()) {
      throw new ApiError(
        'apiKey (secret) must not be used in the browser — it will leak via Network/devtools. ' +
          'On your backend, POST /v2/client-tokens with x-api-key after your user signs in, ' +
          'then pass the pair as clientAuth to the SDK.',
        { code: 'API_KEY_IN_BROWSER' },
      );
    }
    return { kind: 'apiKey', apiKey: config.apiKey! };
  }

  if (hasClient) {
    return {
      kind: 'bearer',
      session: createClientAuthSession(config.clientAuth!, deps),
    };
  }

  if (hasGetter) {
    return {
      kind: 'bearer',
      session: createGetterSession(config.getAccessToken!),
    };
  }

  const staticToken = config.accessToken!;
  return {
    kind: 'bearer',
    session: createGetterSession(async () => staticToken, false),
  };
}

function createClientAuthSession(
  initial: ClientAuth,
  deps: { baseUrl: string; fetch: typeof globalThis.fetch },
): TokenSession {
  let accessToken = initial.accessToken;
  let refreshToken = initial.refreshToken;
  let expiresAt = Number(initial.expiresAt);
  let issuedAt = Date.now();
  let inflight: Promise<void> | undefined;

  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) {
    throw new ApiError(
      'clientAuth requires accessToken, refreshToken, and expiresAt (unix ms)',
      { code: 'INVALID_CONFIG' },
    );
  }

  const applyPair = (pair: ClientAuth): void => {
    accessToken = pair.accessToken;
    refreshToken = pair.refreshToken;
    expiresAt = Number(pair.expiresAt);
    issuedAt = Date.now();
    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) {
      throw new ApiError('refresh returned invalid clientAuth pair', {
        code: 'INVALID_TOKEN',
      });
    }
  };

  const refresh = async (): Promise<void> => {
    if (!inflight) {
      inflight = (async () => {
        const res = await deps.fetch(`${deps.baseUrl}/v2/client-tokens/refresh`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          throw new ApiError(`client token refresh failed (${res.status})`, {
            status: res.status,
            code: 'REFRESH_FAILED',
          });
        }
        const body = (await res.json()) as {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
        };
        applyPair({
          accessToken: body.accessToken ?? '',
          refreshToken: body.refreshToken ?? '',
          expiresAt: body.expiresAt ?? NaN,
        });
      })().finally(() => {
        inflight = undefined;
      });
    }
    await inflight;
  };

  const needsProactiveRefresh = (): boolean => {
    const ttl = expiresAt - issuedAt;
    if (!(ttl > 0)) {
      return Date.now() >= expiresAt - TOKEN_EXPIRY_SKEW_MS;
    }
    const refreshAt = issuedAt + ttl * CLIENT_AUTH_REFRESH_AT;
    return Date.now() >= refreshAt;
  };

  return {
    getToken: async () => {
      if (needsProactiveRefresh()) {
        await refresh();
      }
      return accessToken;
    },
    refreshAfterUnauthorized: async () => {
      try {
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function createGetterSession(
  getter: (ctx: GetAccessTokenContext) => AccessTokenResult | Promise<AccessTokenResult>,
  refreshable = true,
): TokenSession {
  let cache: { token: string; expiresAt?: number } | undefined;
  let inflight: Promise<string> | undefined;

  const load = (reason: GetAccessTokenContext['reason']): Promise<string> => {
    if (!inflight) {
      inflight = (async () => {
        const entry = normalizeTokenResult(await getter({ reason }));
        cache = entry;
        return entry.token;
      })().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };

  return {
    getToken: async (ctx) => {
      const reason = ctx?.reason ?? 'initial';
      if (reason === 'unauthorized' || reason === 'expire_soon') {
        return load(reason);
      }
      if (
        cache &&
        (cache.expiresAt === undefined || Date.now() < cache.expiresAt - TOKEN_EXPIRY_SKEW_MS)
      ) {
        return cache.token;
      }
      if (cache?.expiresAt !== undefined) {
        return load('expire_soon');
      }
      return load('initial');
    },
    refreshAfterUnauthorized: async () => {
      if (!refreshable) {
        return false;
      }
      cache = undefined;
      await load('unauthorized');
      return true;
    },
  };
}

export function normalizeTokenResult(raw: AccessTokenResult): {
  token: string;
  expiresAt?: number;
} {
  if (typeof raw === 'string') {
    if (!raw) {
      throw new ApiError('getAccessToken() returned an empty token', {
        code: 'INVALID_TOKEN',
      });
    }
    return { token: raw };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.accessToken !== 'string' || !raw.accessToken) {
    throw new ApiError('getAccessToken() must return a string or { accessToken, expiresAt? }', {
      code: 'INVALID_TOKEN',
    });
  }
  let expiresAt: number | undefined;
  if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    expiresAt =
      raw.expiresAt instanceof Date ? raw.expiresAt.getTime() : Number(raw.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new ApiError('getAccessToken() expiresAt is invalid', {
        code: 'INVALID_TOKEN',
      });
    }
  }
  return { token: raw.accessToken, expiresAt };
}

export async function authHeaders(auth: ResolvedAuth): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth.kind === 'apiKey') {
    headers['x-api-key'] = auth.apiKey;
  } else {
    headers.Authorization = `Bearer ${await auth.session.getToken()}`;
  }
  return headers;
}
