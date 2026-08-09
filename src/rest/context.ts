import { resolveAuth, type ResolvedAuth } from './auth';
import { createTransport, type HttpTransport } from './http';
import { requestJson, type RequestJsonOpts } from './request';
import { DEFAULT_BASE_URL, MIN_RETRY_BASE_MS, type RestClientConfig } from './types';

export type RestContext = {
  baseUrl: string;
  auth: ResolvedAuth;
  transport: HttpTransport;
  maxRetries: number;
  retryBaseMs: number;
  timeoutMs: number;
  request: <T = unknown>(
    opts: Omit<
      RequestJsonOpts<T>,
      'transport' | 'auth' | 'maxRetries' | 'retryBaseMs' | 'timeoutMs'
    > &
      Partial<Pick<RequestJsonOpts<T>, 'maxRetries' | 'retryBaseMs' | 'timeoutMs'>>,
  ) => Promise<T>;
  close: () => void;
};

export type RestContextConfig = RestClientConfig & {
  /** Node undici connection pool size. Default 8. */
  connections?: number;
};

/**
 * Shared auth + transport for one or more public-api resources.
 * One context per app — `clientAuth` refresh stays single-flight.
 */
export function createRestContext(config: RestContextConfig): RestContext {
  let retryBaseMs = config.retryBaseMs ?? 1000;
  if (retryBaseMs < MIN_RETRY_BASE_MS) {
    retryBaseMs = MIN_RETRY_BASE_MS;
  }
  const maxRetries = config.maxRetries ?? 3;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const connections = config.connections ?? 8;

  const transport = createTransport(connections, config.fetch);
  const auth = resolveAuth(config, { baseUrl, fetch: transport.fetch });

  return {
    baseUrl,
    auth,
    transport,
    maxRetries,
    retryBaseMs,
    timeoutMs,
    request: (opts) =>
      requestJson({
        transport,
        auth,
        maxRetries,
        retryBaseMs,
        timeoutMs,
        ...opts,
      }),
    close: () => transport.close(),
  };
}
