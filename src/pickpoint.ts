import { createRestContext, type RestContext } from './rest/context';
import type { RestClientConfig } from './rest/types';
import { AddressResource } from './resources/address';
import { DevicesResource } from './resources/devices';
import {
  GeocodingResource,
  MAX_CONCURRENCY,
  type ForwardInput,
  type ForwardResult,
  type LookupInput,
  type LookupResult,
  type ReverseInput,
  type ReverseResult,
} from './resources/geocoding';
import { RoutingResource, type RoutingBody } from './resources/routing';

export type PickPointOptions = RestClientConfig & {
  /**
   * Parallel geocode requests in a batch.
   * Default and max: {@link MAX_CONCURRENCY}.
   */
  concurrency?: number;
};

/**
 * Unified public-api client (geocoding, address, routing, devices).
 *
 * Prefer namespaced calls for clarity; flat shortcuts are bound so
 * destructuring keeps working:
 *
 * ```ts
 * const pp = new PickPoint({ clientAuth: pair })
 * await pp.forward({ q: 'Berlin' })
 * await pp.devices.list()
 *
 * const { forward, search, route } = pp
 * await forward({ q: 'Paris' })
 * ```
 *
 * Tracking (WebSocket) stays on `@pickpoint/sdk/tracking` — different lifecycle.
 */
export class PickPoint {
  readonly #ctx: RestContext;

  /** Nominatim-style forward / reverse / lookup (+ batch). */
  readonly geocoding: GeocodingResource;
  /** Photon address autocomplete (`/v2/address/search`). */
  readonly address: AddressResource;
  /** Valhalla routing proxies. */
  readonly routing: RoutingResource;
  /** Device CRUD + command. */
  readonly devices: DevicesResource;

  constructor(options: PickPointOptions) {
    const connections = Math.max(
      options.connections ?? 8,
      options.concurrency ?? MAX_CONCURRENCY,
    );
    this.#ctx = createRestContext({ ...options, connections });
    this.geocoding = new GeocodingResource(this.#ctx, {
      concurrency: options.concurrency,
    });
    this.address = new AddressResource(this.#ctx);
    this.routing = new RoutingResource(this.#ctx);
    this.devices = new DevicesResource(this.#ctx);
  }

  // ——— Flat shortcuts (arrow fields → safe to destructure) ———

  forward = ((input: ForwardInput | ForwardInput[]) =>
    this.geocoding.forward(input as ForwardInput)) as {
    (input: ForwardInput): Promise<ForwardResult>;
    (inputs: ForwardInput[]): Promise<ForwardResult[]>;
  };

  reverse = ((input: ReverseInput | ReverseInput[]) =>
    this.geocoding.reverse(input as ReverseInput)) as {
    (input: ReverseInput): Promise<ReverseResult>;
    (inputs: ReverseInput[]): Promise<ReverseResult[]>;
  };

  lookup = ((input: LookupInput | LookupInput[]) =>
    this.geocoding.lookup(input as LookupInput)) as {
    (input: LookupInput): Promise<LookupResult>;
    (inputs: LookupInput[]): Promise<LookupResult[]>;
  };

  search = (input?: Parameters<AddressResource['search']>[0]) => this.address.search(input);

  route = (body: RoutingBody) => this.routing.route(body);

  optimizedRoute = (body: RoutingBody) => this.routing.optimized(body);

  matrix = (body: RoutingBody) => this.routing.matrix(body);

  locate = (body: RoutingBody) => this.routing.locate(body);

  elevation = (body: RoutingBody) => this.routing.elevation(body);

  /** Release Node keep-alive connections. */
  close = (): void => {
    this.#ctx.close();
  };
}
