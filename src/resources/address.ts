import type { RestContext } from '../rest/context.js';
import { toQuery } from '../rest/request.js';

/** Photon-style address search query (`GET /v2/address/search`). */
export type AddressSearchInput = {
  q?: string;
  lat?: number;
  lon?: number;
  limit?: number;
  lang?: string;
  bbox?: string;
  location_bias_scale?: number;
  [key: string]: string | number | boolean | undefined;
};

/** GeoJSON FeatureCollection (or error payload from Photon). */
export type AddressSearchResult = Record<string, unknown>;

export class AddressResource {
  readonly #ctx: RestContext;

  constructor(ctx: RestContext) {
    this.#ctx = ctx;
  }

  /** Autocomplete / place search. */
  search(input: AddressSearchInput = {}): Promise<AddressSearchResult> {
    const qs = toQuery(input);
    return this.#ctx.request<AddressSearchResult>({
      url: `${this.#ctx.baseUrl}/v2/address/search${qs ? `?${qs}` : ''}`,
    });
  }
}
