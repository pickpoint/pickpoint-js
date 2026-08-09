import type { RestContext } from '../rest/context.js';
import { toQuery } from '../rest/request.js';

export type Device = {
  id: number;
  uid: string;
  name: string;
  status: string;
  description?: string | null;
  tracksCount?: number;
  type: string;
  secret?: string;
  metadata?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastLocation?: unknown;
  createdBy?: { id?: number | null; fullName?: string | null };
  updatedBy?: { id?: number | null; fullName?: string | null } | null;
  [key: string]: unknown;
};

export type DeviceInput = {
  name: string;
  type: string;
  description?: string;
  metadata?: string;
};

export type DeviceListQuery = {
  skip?: number;
  take?: number;
  search?: string;
  /** When set, only idle devices. */
  idle?: boolean | string;
};

export type DeviceListResult = {
  data: Device[];
  total: number;
};

export type DeviceCommandResult = {
  delivered: number;
};

export class DevicesResource {
  readonly #ctx: RestContext;

  constructor(ctx: RestContext) {
    this.#ctx = ctx;
  }

  list(query: DeviceListQuery = {}): Promise<DeviceListResult> {
    const q: Record<string, string | number | boolean | undefined> = {
      skip: query.skip,
      take: query.take,
      search: query.search,
    };
    if (query.idle !== undefined && query.idle !== false) {
      q.idle = typeof query.idle === 'string' ? query.idle : '1';
    }
    const qs = toQuery(q);
    return this.#ctx.request<DeviceListResult>({
      url: `${this.#ctx.baseUrl}/v2/devices${qs ? `?${qs}` : ''}`,
    });
  }

  get(uid: string): Promise<Device> {
    return this.#ctx.request<Device>({
      url: `${this.#ctx.baseUrl}/v2/devices/${encodeURIComponent(uid)}`,
    });
  }

  create(body: DeviceInput): Promise<Device> {
    return this.#ctx.request<Device>({
      url: `${this.#ctx.baseUrl}/v2/devices`,
      method: 'POST',
      body,
    });
  }

  update(uid: string, body: DeviceInput): Promise<Device> {
    return this.#ctx.request<Device>({
      url: `${this.#ctx.baseUrl}/v2/devices/${encodeURIComponent(uid)}`,
      method: 'PATCH',
      body,
    });
  }

  delete(uid: string): Promise<void> {
    return this.#ctx.request<void>({
      url: `${this.#ctx.baseUrl}/v2/devices/${encodeURIComponent(uid)}`,
      method: 'DELETE',
      noContent: () => undefined,
    });
  }

  /**
   * Inject opaque bytes into an online device session.
   * Pass base64 string, or raw bytes (`Uint8Array` / `ArrayBuffer`).
   */
  command(
    uid: string,
    payload: string | Uint8Array | ArrayBuffer,
  ): Promise<DeviceCommandResult> {
    const encoded =
      typeof payload === 'string' ? payload : bytesToBase64(payload);
    return this.#ctx.request<DeviceCommandResult>({
      url: `${this.#ctx.baseUrl}/v2/devices/${encodeURIComponent(uid)}/command`,
      method: 'POST',
      body: { payload: encoded },
    });
  }
}

function bytesToBase64(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
