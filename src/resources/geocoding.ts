import type { RestContext } from '../rest/context.js';
import { createPool } from '../rest/pool.js';
import { toQuery } from '../rest/request.js';

/** Hard cap on in-flight geocode HTTP requests. Also the default. */
export const MAX_CONCURRENCY = 20;

/** Soft warn when a batch has this many items or more. */
export const SOFT_BATCH_WARN = 10_000;

/** Forward geocode input (Nominatim search-style query). */
export type ForwardInput = {
  q?: string;
  street?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  postalcode?: string;
  countrycodes?: string;
  viewbox?: string;
  bounded?: string | number | boolean;
  limit?: number;
  'accept-language'?: string;
  addressdetails?: string | number | boolean;
  extratags?: string | number | boolean;
  namedetails?: string | number | boolean;
  polygon_geojson?: string | number | boolean;
  [key: string]: string | number | boolean | undefined;
};

/** Reverse geocode input. */
export type ReverseInput = {
  lat: number;
  lon: number;
  zoom?: number;
  'accept-language'?: string;
  addressdetails?: string | number | boolean;
  extratags?: string | number | boolean;
  namedetails?: string | number | boolean;
  polygon_geojson?: string | number | boolean;
  [key: string]: string | number | boolean | undefined;
};

/** Lookup by OSM ids (Nominatim-style). */
export type LookupInput = {
  osm_ids?: string;
  'accept-language'?: string;
  addressdetails?: string | number | boolean;
  extratags?: string | number | boolean;
  namedetails?: string | number | boolean;
  polygon_geojson?: string | number | boolean;
  [key: string]: string | number | boolean | undefined;
};

export type ForwardResult = unknown[];
export type ReverseResult = Record<string, unknown> | null;
export type LookupResult = unknown[];

export type GeocodingResourceOptions = {
  /** Parallel requests in a batch. Default and max: {@link MAX_CONCURRENCY}. */
  concurrency?: number;
};

export class GeocodingResource {
  readonly #ctx: RestContext;
  readonly #pool: ReturnType<typeof createPool>;

  constructor(ctx: RestContext, opts: GeocodingResourceOptions = {}) {
    this.#ctx = ctx;
    let concurrency = opts.concurrency ?? MAX_CONCURRENCY;
    if (concurrency > MAX_CONCURRENCY) {
      console.warn(
        `[pickpoint] geocoding concurrency ${concurrency} exceeds max ${MAX_CONCURRENCY}; clamping`,
      );
      concurrency = MAX_CONCURRENCY;
    }
    if (concurrency < 1) {
      concurrency = 1;
    }
    this.#pool = createPool(concurrency);
  }

  forward(input: ForwardInput): Promise<ForwardResult>;
  forward(inputs: ForwardInput[]): Promise<ForwardResult[]>;
  forward(input: ForwardInput | ForwardInput[]): Promise<ForwardResult | ForwardResult[]> {
    if (Array.isArray(input)) {
      return this.#batch(input, (item, signal) => this.#forwardOne(item, signal), 'forward');
    }
    return this.#forwardOne(input, new AbortController().signal);
  }

  reverse(input: ReverseInput): Promise<ReverseResult>;
  reverse(inputs: ReverseInput[]): Promise<ReverseResult[]>;
  reverse(input: ReverseInput | ReverseInput[]): Promise<ReverseResult | ReverseResult[]> {
    if (Array.isArray(input)) {
      return this.#batch(input, (item, signal) => this.#reverseOne(item, signal), 'reverse');
    }
    return this.#reverseOne(input, new AbortController().signal);
  }

  lookup(input: LookupInput): Promise<LookupResult>;
  lookup(inputs: LookupInput[]): Promise<LookupResult[]>;
  lookup(input: LookupInput | LookupInput[]): Promise<LookupResult | LookupResult[]> {
    if (Array.isArray(input)) {
      return this.#batch(input, (item, signal) => this.#lookupOne(item, signal), 'lookup');
    }
    return this.#lookupOne(input, new AbortController().signal);
  }

  readonly batch = {
    forward: (inputs: ForwardInput[]) => this.forward(inputs),
    reverse: (inputs: ReverseInput[]) => this.reverse(inputs),
    lookup: (inputs: LookupInput[]) => this.lookup(inputs),
  };

  #forwardOne(input: ForwardInput, signal: AbortSignal): Promise<ForwardResult> {
    return this.#pool.run(() =>
      this.#ctx.request<ForwardResult>({
        url: `${this.#ctx.baseUrl}/v2/geocode/forward?${toQuery(input)}`,
        signal,
        onClientError: 'empty',
        empty: () => [],
        parse: (body) => (Array.isArray(body) ? body : body == null ? [] : [body]),
      }),
    );
  }

  #reverseOne(input: ReverseInput, signal: AbortSignal): Promise<ReverseResult> {
    return this.#pool.run(() =>
      this.#ctx.request<ReverseResult>({
        url: `${this.#ctx.baseUrl}/v2/geocode/reverse?${toQuery(input)}`,
        signal,
        onClientError: 'empty',
        empty: () => null,
        parse: (body) => {
          if (body == null || typeof body !== 'object') {
            return null;
          }
          return body as Record<string, unknown>;
        },
      }),
    );
  }

  #lookupOne(input: LookupInput, signal: AbortSignal): Promise<LookupResult> {
    return this.#pool.run(() =>
      this.#ctx.request<LookupResult>({
        url: `${this.#ctx.baseUrl}/v2/address/lookup?${toQuery(input)}`,
        signal,
        onClientError: 'empty',
        empty: () => [],
        parse: (body) => (Array.isArray(body) ? body : body == null ? [] : [body]),
      }),
    );
  }

  async #batch<TIn, TOut>(
    inputs: TIn[],
    worker: (input: TIn, signal: AbortSignal) => Promise<TOut>,
    kind: string,
  ): Promise<TOut[]> {
    if (inputs.length >= SOFT_BATCH_WARN) {
      console.warn(
        `[pickpoint] ${kind} batch size ${inputs.length} is very large (≥ ${SOFT_BATCH_WARN}). ` +
          `Consider splitting into chunks of 1–2k to limit memory, runtime, and quota usage.`,
      );
    }
    const ac = new AbortController();
    const results = new Array<TOut>(inputs.length);
    try {
      await Promise.all(
        inputs.map(async (item, i) => {
          results[i] = await worker(item, ac.signal);
        }),
      );
      return results;
    } catch (err) {
      ac.abort();
      throw err;
    }
  }
}
