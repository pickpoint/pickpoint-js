/**
 * @pickpoint/sdk
 *
 * ```ts
 * import { PickPoint } from '@pickpoint/sdk'
 *
 * const pp = new PickPoint({ clientAuth: pair })
 * await pp.forward({ q: 'Berlin' })
 * await pp.search({ q: 'Berlin' })
 * await pp.devices.list()
 * ```
 *
 * Tracking (WebSocket): `@pickpoint/sdk/tracking`
 */

export { PickPoint } from './pickpoint';
export type { PickPointOptions } from './pickpoint';

export { ApiAuthError, ApiError } from './rest/errors';
export {
  CLIENT_AUTH_REFRESH_AT,
  isBrowserRuntime,
  resolveAuth,
  TOKEN_EXPIRY_SKEW_MS,
} from './rest/auth';
export { MIN_RETRY_BASE_MS } from './rest/types';
export type {
  AccessTokenResult,
  ClientAuth,
  GetAccessTokenContext,
  RestClientConfig,
} from './rest/types';

export { MAX_CONCURRENCY, SOFT_BATCH_WARN } from './resources/geocoding';
export type {
  ForwardInput,
  ForwardResult,
  LookupInput,
  LookupResult,
  ReverseInput,
  ReverseResult,
} from './resources/geocoding';
export type { AddressSearchInput, AddressSearchResult } from './resources/address';
export type { RoutingBody } from './resources/routing';
export type {
  Device,
  DeviceCommandResult,
  DeviceInput,
  DeviceListQuery,
  DeviceListResult,
} from './resources/devices';

export * as tracking from './tracking/index';
