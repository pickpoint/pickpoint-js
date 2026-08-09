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

export { PickPoint } from './pickpoint.js';
export type { PickPointOptions } from './pickpoint.js';

export { ApiAuthError, ApiError } from './rest/errors.js';
export {
  CLIENT_AUTH_REFRESH_AT,
  isBrowserRuntime,
  TOKEN_EXPIRY_SKEW_MS,
} from './rest/auth.js';
export { MIN_RETRY_BASE_MS } from './rest/types.js';
export type {
  AccessTokenResult,
  ClientAuth,
  GetAccessTokenContext,
  RestClientConfig,
} from './rest/types.js';

export { MAX_CONCURRENCY, SOFT_BATCH_WARN } from './resources/geocoding.js';
export type {
  ForwardInput,
  ForwardResult,
  LookupInput,
  LookupResult,
  ReverseInput,
  ReverseResult,
} from './resources/geocoding.js';
export type { AddressSearchInput, AddressSearchResult } from './resources/address.js';
export type { RoutingBody } from './resources/routing.js';
export type {
  Device,
  DeviceCommandResult,
  DeviceInput,
  DeviceListQuery,
  DeviceListResult,
} from './resources/devices.js';

export * as tracking from './tracking/index.js';
