import type {
  Command,
  DevicePresence,
  ErrorCode,
  EventAdded,
  LatLng,
  LocationAdded,
  Subscribed,
} from '../gen/tracking/v2/messages_pb.js';

export type DeviceAuth = {
  clientId: string;
  clientSecret: string;
};

export type ListenerAuth = {
  accessToken: string;
};

export type Auth = DeviceAuth | ListenerAuth;

export function isDeviceAuth(auth: Auth): auth is DeviceAuth {
  return 'clientId' in auth && 'clientSecret' in auth;
}

export type LatLngInput = {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  /** Unix epoch ms; defaults to Date.now() when omitted */
  timestampMs?: number | bigint;
};

export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export type ReconnectOptions = {
  /** Default 500 */
  minDelayMs?: number;
  /** Default 30_000 */
  maxDelayMs?: number;
  /** Default Infinity */
  maxAttempts?: number;
};

export type TrackingConfig = {
  /**
   * Base origin, e.g. `wss://tracking.pickpoint.io` or `https://tracking.pickpoint.io`.
   * Path defaults to `/v2/tracking/ws`.
   */
  endpoint: string;
  auth: Auth;
  /** Default `/v2/tracking/ws` */
  path?: string;
  /**
   * Max offline location points kept for flush after resume.
   * Default 10_000 (~8 min at 20 Hz, ~2.7 h at 1 Hz). Drop-oldest on overflow.
   */
  maxQueueSize?: number;
  /**
   * Auto-reconnect after unexpected drop. Default true.
   * Pass `false` to disable, or tune backoff.
   */
  reconnect?: boolean | ReconnectOptions;
  /**
   * Called when the server returns AUTH / UNAUTHORIZED before giving up reconnect.
   * Return fresh credentials to retry.
   */
  refreshAuth?: () => Promise<Auth>;
  /** Inject WebSocket implementation (tests / exotic runtimes). */
  WebSocketImpl?: WebSocketConstructor;
  /** How long to wait for Hello after open. Default 10_000. */
  helloTimeoutMs?: number;
  /**
   * When true (default for device auth), automatically ack commands with OK
   * after emitting `command`. Set false to ack manually via `ackCommand`.
   */
  autoAckCommands?: boolean;
};

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** Minimal socket surface used by the client (browser + `ws`). */
export type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  readonly protocol: string;
  send(data: ArrayBuffer | Uint8Array | Buffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
  removeEventListener(type: string, listener: (ev: any) => void): void;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
};

export type TrackingError = {
  code: ErrorCode;
  message: string;
  trackUid?: string;
  retryAfterMs?: number;
};

export type RelocateInfo = {
  endpoint: string;
  retryAfterMs: number;
};

export type TrackingEvents = {
  state: (state: ConnectionState) => void;
  open: () => void;
  close: (info: { code: number; reason: string; wasClean: boolean }) => void;
  error: (err: TrackingError | Error) => void;
  relocate: (info: RelocateInfo) => void;
  resumeOk: (info: { trackUid: string; lastAckedSeq: bigint }) => void;
  trackStarted: (trackUid: string) => void;
  trackStopped: (trackUid: string) => void;
  location: (msg: LocationAdded) => void;
  /** Opaque custom event fan-out (not stored). */
  event: (msg: EventAdded) => void;
  /** Opaque command from API → this device (not stored). */
  command: (msg: Command) => void;
  presence: (msg: DevicePresence) => void;
  subscribed: (msg: Subscribed) => void;
  /** Offline queue dropped oldest points (capacity). */
  queueGap: (dropped: number) => void;
};

export type StartTrackOptions = {
  location?: LatLngInput;
  route?: LatLngInput[];
  /** Opaque ≤4 KiB app metadata (trip/order/…). */
  metadata?: Uint8Array;
};

export type SubscribeOptions = {
  /** Default true. */
  includeEvents?: boolean;
  minLocationIntervalMs?: number;
};

export type TrackingClient = {
  readonly state: ConnectionState;
  /** Active device track cursor, if any. */
  readonly trackUid: string | undefined;
  readonly clientSeq: bigint;
  readonly lastAckedSeq: bigint;

  startTrack(opts?: StartTrackOptions): Promise<string>;
  stopTrack(trackUid?: string): Promise<void>;
  /**
   * Enqueue + send when open; assigns next clientSeq.
   * Over 50 Hz the point is dropped and the current seq is returned.
   */
  publish(point: LatLngInput): bigint;
  /** Like publish; accepts a 50 Hz-fitting prefix, drops the rest. */
  publishBatch(points: LatLngInput[]): bigint;
  /**
   * Opaque custom event (≤4 KiB, ≤1 Hz). Ephemeral fan-out only.
   * Returns false if dropped due to rate limit.
   */
  sendEvent(payload: Uint8Array | ArrayBuffer | ArrayBufferView): boolean;
  /** Ack a received command (call after handling, or rely on autoAckCommands). */
  ackCommand(
    commandId: string,
    status?: 'ok' | 'rejected' | 'failed',
    message?: string,
  ): void;
  subscribe(deviceUid: string, opts?: SubscribeOptions): Promise<Subscribed>;
  unsubscribe(deviceUid: string): Promise<void>;
  ping(): void;

  on<K extends keyof TrackingEvents>(event: K, handler: TrackingEvents[K]): () => void;
  close(opts?: { code?: number; reason?: string }): void;
};

export type {
  Command,
  DevicePresence,
  EventAdded,
  LatLng,
  LocationAdded,
  Subscribed,
  ErrorCode,
};
