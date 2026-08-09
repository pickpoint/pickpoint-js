/** Why the SDK is asking for a token. */
export type GetAccessTokenContext = {
  /**
   * `initial` — first mint / cold cache
   * `expire_soon` — cached token past expiresAt − skew (proactive refresh)
   * `unauthorized` — API returned 401; one forced refresh then retry
   */
  reason: 'initial' | 'expire_soon' | 'unauthorized';
};

/** String token, or object with optional expiry for proactive refresh. */
export type AccessTokenResult =
  | string
  | {
      accessToken: string;
      /** Unix ms or Date. SDK refreshes ~30s before this. */
      expiresAt?: number | Date;
    };

/** Pair from `POST /v2/client-tokens` (via your backend). */
export type ClientAuth = {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds when accessToken expires. */
  expiresAt: number;
};

/** Shared auth + transport options for public-api HTTP clients. */
export type RestClientConfig = {
  /**
   * Recommended for SPAs: pair minted by your backend via
   * `POST /v2/client-tokens` (secret key stays server-side).
   * SDK refreshes at ~50% of TTL and on 401 — you do not manage timers.
   */
  clientAuth?: ClientAuth;
  /**
   * Secret API key (`x-api-key`). **Server-side (Node) only** — rejected in
   * browsers. Prefer `clientAuth` for web apps.
   */
  apiKey?: string;
  /**
   * Static Bearer token (not refreshable). Prefer `clientAuth`.
   */
  accessToken?: string;
  /**
   * Low-level escape hatch. Prefer `clientAuth` for Pickpoint client-tokens.
   */
  getAccessToken?: (
    ctx: GetAccessTokenContext,
  ) => AccessTokenResult | Promise<AccessTokenResult>;
  /** Default `https://api.pickpoint.io`. */
  baseUrl?: string;
  /** Retries after 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default 1000; min {@link MIN_RETRY_BASE_MS}. */
  retryBaseMs?: number;
  /** Override fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Request timeout per attempt (ms). Default 30_000. */
  timeoutMs?: number;
  /**
   * Keep-alive pool size (Node). Default 8 for non-batch clients;
   * geocoding raises this with concurrency.
   */
  connections?: number;
};

/** Minimum retry base delay (ms). */
export const MIN_RETRY_BASE_MS = 200;

export const DEFAULT_BASE_URL = 'https://api.pickpoint.io';
