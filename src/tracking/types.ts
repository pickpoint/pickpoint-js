export enum ErrorCode {
  AUTH = 1,
  TRACK_NOT_FOUND = 2,
  FENCED = 3,
  TRY_AGAIN = 4,
  INVALID = 5,
  UNAUTHORIZED = 6,
}

export enum CommandAckStatus {
  OK = 1,
  REJECTED = 2,
  FAILED = 3,
}

/** Point as used on the wire (no heading/speed). */
export type LatLng = {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  /** Unix epoch ms; omitted on live Loc (server stamps now). */
  timestampMs?: number;
};

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
  /** Used only by the device GPS filter; never written to the wire. */
  heading?: number;
  /** Used only by the device GPS filter; never written to the wire. */
  speed?: number;
  /** Unix epoch ms; capture time for Staging / reconnect flush. */
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
   * Path defaults to `/v2/ws`.
   */
  endpoint: string;
  auth: Auth;
  /** Default `/v2/ws` */
  path?: string;
  /**
   * Max Staging + InFlight points (reconnect.md). Default 10_000.
   * Overflow collapses collinear samples in the middle, keeps newest.
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
  /**
   * Listener: device UID(s) to watch after Hello (and after reconnect).
   */
  subscribe?: string | string[];
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

/** Listener live point (`0x86 Loc`). Not used for device Ack. */
export type LocationAdded = {
  sub: number;
  deviceUid: string;
  seq: bigint;
  point: LatLng;
};

export type EventAdded = {
  sub: number;
  deviceUid: string;
  payload: Uint8Array;
  timestampMs?: number;
};

export type Command = {
  commandId: string;
  payload: Uint8Array;
  timestampMs?: number;
};

export type DevicePresence = {
  sub: number;
  deviceUid: string;
  online: boolean;
  lastSeenMs?: number;
};

export type Subscribed = {
  sub: number;
  deviceUid: string;
  trackUid: string;
  online: boolean;
  lastLocation?: LatLng;
  lastSeenMs?: number;
  route: LatLng[];
  estimatedDistance: number;
  estimatedDuration: number;
  startLocationName: string;
  endLocationName: string;
  metadata: Uint8Array;
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
  /** Listener `0x86 Loc` only. Device Ack is not a location event. */
  location: (msg: LocationAdded) => void;
  /** Opaque custom event fan-out (not stored). */
  event: (msg: EventAdded) => void;
  /** Opaque command from API → this device (not stored). */
  command: (msg: Command) => void;
  presence: (msg: DevicePresence) => void;
  subscribed: (msg: Subscribed) => void;
  /** Staging+InFlight overflow (capacity). */
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
   * Filter → Staging or seq+Loc when open.
   * Over 50 Hz the sample is dropped and the current seq is returned.
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

  on<K extends keyof TrackingEvents>(event: K, handler: TrackingEvents[K]): () => void;
  close(opts?: { code?: number; reason?: string }): void;
};

export type ClientMsg =
  | { type: 'resume'; trackUid: string; lastSeq: number }
  | {
      type: 'trackStart';
      location?: LatLng;
      route: LatLng[];
      metadata: Uint8Array;
    }
  | { type: 'trackStop' }
  | { type: 'loc'; seq: number; points: LatLng[] }
  | {
      type: 'subscribe';
      deviceUid: string;
      includeEvents: boolean;
      minIntervalMs: number;
    }
  | { type: 'unsubscribe'; sub: number }
  | { type: 'event'; payload: Uint8Array; timestampMs: number }
  | {
      type: 'commandAck';
      commandId: string;
      status: CommandAckStatus;
      message: string;
    };

export type ServerMsg =
  | { type: 'hello'; version: number; shard: number; nodeId: string }
  | { type: 'relocate'; retryAfterMs: number; endpoint: string }
  | { type: 'resumeOk'; trackUid: string; lastAckedSeq: number }
  | { type: 'trackStarted'; trackUid: string; metadata: Uint8Array }
  | { type: 'trackStopped'; trackUid: string }
  | { type: 'ack'; seq: number }
  | { type: 'loc'; sub: number; seq: number; point: LatLng }
  | ({ type: 'subscribed' } & Subscribed)
  | { type: 'error'; code: ErrorCode; message: string; trackUid?: string; retryAfterMs?: number }
  | { type: 'eventAdded'; sub: number; payload: Uint8Array; timestampMs?: number }
  | { type: 'command'; commandId: string; payload: Uint8Array; timestampMs?: number }
  | { type: 'presence'; sub: number; online: boolean; lastSeenMs?: number };
