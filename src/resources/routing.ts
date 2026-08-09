import type { RestContext } from '../rest/context.js';

/** Valhalla-compatible JSON body (typed loosely — shapes vary by costing). */
export type RoutingBody = Record<string, unknown>;

export class RoutingResource {
  readonly #ctx: RestContext;

  constructor(ctx: RestContext) {
    this.#ctx = ctx;
  }

  /** `POST /v2/route` */
  route(body: RoutingBody): Promise<unknown> {
    return this.#post('/v2/route', body);
  }

  /** `POST /v2/route/optimized` */
  optimized(body: RoutingBody): Promise<unknown> {
    return this.#post('/v2/route/optimized', body);
  }

  /** `POST /v2/route/matrix` */
  matrix(body: RoutingBody): Promise<unknown> {
    return this.#post('/v2/route/matrix', body);
  }

  /** `POST /v2/route/locate` */
  locate(body: RoutingBody): Promise<unknown> {
    return this.#post('/v2/route/locate', body);
  }

  /** `POST /v2/route/elevation` */
  elevation(body: RoutingBody): Promise<unknown> {
    return this.#post('/v2/route/elevation', body);
  }

  #post(path: string, body: RoutingBody): Promise<unknown> {
    return this.#ctx.request({
      url: `${this.#ctx.baseUrl}${path}`,
      method: 'POST',
      body,
    });
  }
}
