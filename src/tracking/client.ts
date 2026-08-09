import { ErrorCode, type ServerMsg, type Subscribed } from '../gen/tracking/v2/messages_pb';
import {
  createBackoff,
  nextDelayMs,
  resetBackoff,
  type BackoffState,
} from './backoff';
import {
  clientCommandAck,
  clientEvent,
  clientLocationAdd,
  clientLocationBatch,
  clientPing,
  clientResume,
  clientSubscribe,
  clientTrackStart,
  clientTrackStop,
  clientUnsubscribe,
  decodeServerMsg,
  encodeClientMsg,
  messageBytes,
} from './codec';
import { isFatalResumeError, TrackingSdkError } from './errors';
import { OfflineQueue } from './queue';
import {
  canAcceptPublish,
  MAX_EVENT_BYTES,
  MIN_EVENT_INTERVAL_MS,
  nextPublishAllowedAt,
} from './rate';
import { openSocket, resolveWebSocketCtor, WS_OPEN } from './socket';
import type {
  Auth,
  ConnectionState,
  LatLngInput,
  ReconnectOptions,
  StartTrackOptions,
  SubscribeOptions,
  TrackingClient,
  TrackingConfig,
  TrackingEvents,
  WebSocketConstructor,
  WebSocketLike,
} from './types';
import { isDeviceAuth } from './types';
import { buildWsUrl } from './url';

type Pending<T> = {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
};

class TrackingSession implements TrackingClient {
  private auth: Auth;
  private endpoint: string;
  private readonly path: string;
  private readonly helloTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectOpts: ReconnectOptions | undefined;
  private readonly refreshAuth?: () => Promise<Auth>;
  private readonly WebSocketImpl?: WebSocketConstructor;
  private readonly autoAckCommands: boolean;

  private socket: WebSocketLike | null = null;
  private _state: ConnectionState = 'closed';
  private _trackUid: string | undefined;
  private _clientSeq = 0n;
  private _lastAckedSeq = 0n;
  private readonly queue: OfflineQueue;
  private nextPublishAt = 0;
  private nextEventAt = 0;
  private backoff: BackoffState;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dialGeneration = 0;
  private readonly subscriptions = new Set<string>();
  private readonly listeners = new Map<keyof TrackingEvents, Set<Function>>();

  private startWaiters: Pending<string>[] = [];
  private stopWaiters: Pending<void>[] = [];
  private subscribeWaiters = new Map<string, Pending<Subscribed>[]>();
  private resumeWaiters: Pending<void>[] = [];

  constructor(config: TrackingConfig) {
    this.endpoint = config.endpoint;
    this.auth = config.auth;
    this.path = config.path ?? '/v2/tracking/ws';
    this.helloTimeoutMs = config.helloTimeoutMs ?? 10_000;
    this.refreshAuth = config.refreshAuth;
    this.WebSocketImpl = config.WebSocketImpl;
    this.autoAckCommands =
      config.autoAckCommands ?? isDeviceAuth(config.auth);

    if (config.reconnect === false) {
      this.reconnectEnabled = false;
      this.reconnectOpts = undefined;
    } else {
      this.reconnectEnabled = true;
      this.reconnectOpts =
        typeof config.reconnect === 'object' ? config.reconnect : undefined;
    }
    this.backoff = createBackoff(this.reconnectOpts);

    this.queue = new OfflineQueue(config.maxQueueSize ?? 10_000, (dropped) => {
      this.emit('queueGap', dropped);
    });
  }

  get state(): ConnectionState {
    return this._state;
  }

  get trackUid(): string | undefined {
    return this._trackUid;
  }

  get clientSeq(): bigint {
    return this._clientSeq;
  }

  get lastAckedSeq(): bigint {
    return this._lastAckedSeq;
  }

  on<K extends keyof TrackingEvents>(event: K, handler: TrackingEvents[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async startTrack(opts: StartTrackOptions = {}): Promise<string> {
    this.assertUsable();
    await this.ensureOpen();
    return new Promise<string>((resolve, reject) => {
      this.startWaiters.push({ resolve, reject });
      try {
        this.send(clientTrackStart(opts.location, opts.route, opts.metadata));
      } catch (e) {
        this.startWaiters.pop();
        reject(asError(e));
      }
    });
  }

  async stopTrack(trackUid?: string): Promise<void> {
    this.assertUsable();
    const uid = trackUid ?? this._trackUid;
    if (!uid) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'no active track');
    }
    await this.ensureOpen();
    return new Promise<void>((resolve, reject) => {
      this.stopWaiters.push({ resolve, reject });
      try {
        this.send(clientTrackStop(uid));
      } catch (e) {
        this.stopWaiters.pop();
        reject(asError(e));
      }
    });
  }

  publish(point: LatLngInput): bigint {
    this.assertUsable();
    if (!this._trackUid) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'startTrack() before publish()');
    }
    // Over 50 Hz: drop silently (no seq bump). Resume flush bypasses this gate.
    if (!this.tryAcceptPublish(1)) {
      return this._clientSeq;
    }
    this._clientSeq += 1n;
    const seq = this._clientSeq;
    this.queue.enqueue(seq, point);
    if (this.isSocketOpen()) {
      this.send(clientLocationAdd(this._trackUid, seq, point));
    }
    return seq;
  }

  publishBatch(points: LatLngInput[]): bigint {
    this.assertUsable();
    if (!this._trackUid) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'startTrack() before publishBatch()');
    }
    if (points.length === 0) {
      return this._clientSeq;
    }
    // Accept a prefix that fits the 50 Hz budget; drop the rest.
    const accepted: LatLngInput[] = [];
    for (const p of points) {
      if (!this.tryAcceptPublish(1)) {
        break;
      }
      accepted.push(p);
    }
    if (accepted.length === 0) {
      return this._clientSeq;
    }
    let last = this._clientSeq;
    for (const p of accepted) {
      this._clientSeq += 1n;
      last = this._clientSeq;
      this.queue.enqueue(last, p);
    }
    if (this.isSocketOpen()) {
      this.send(clientLocationBatch(this._trackUid, last, accepted));
    }
    return last;
  }

  /** Returns false when over 50 Hz (caller should drop). */
  private tryAcceptPublish(pointCount: number): boolean {
    const now = Date.now();
    if (!canAcceptPublish(this.nextPublishAt, now, pointCount)) {
      return false;
    }
    this.nextPublishAt = nextPublishAllowedAt(this.nextPublishAt, now, pointCount);
    return true;
  }

  /**
   * Send an opaque custom event (≤4 KiB, ≤1 Hz). Not queued / not resumed.
   * Returns false if dropped (rate) or throws if payload too large / no track.
   */
  sendEvent(payload: Uint8Array | ArrayBuffer | ArrayBufferView): boolean {
    this.assertUsable();
    if (!this._trackUid) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'startTrack() before sendEvent()');
    }
    const bytes = messageBytes(payload);
    if (bytes.byteLength > MAX_EVENT_BYTES) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'event payload exceeds 4 KiB');
    }
    const now = Date.now();
    if (now < this.nextEventAt) {
      return false;
    }
    this.nextEventAt = now + MIN_EVENT_INTERVAL_MS;
    if (this.isSocketOpen()) {
      this.send(clientEvent(this._trackUid, bytes));
    }
    return true;
  }

  async subscribe(
    deviceUid: string,
    opts?: SubscribeOptions,
  ): Promise<Subscribed> {
    this.assertUsable();
    await this.ensureOpen();
    this.subscriptions.add(deviceUid);
    return new Promise<Subscribed>((resolve, reject) => {
      const list = this.subscribeWaiters.get(deviceUid) ?? [];
      list.push({ resolve, reject });
      this.subscribeWaiters.set(deviceUid, list);
      try {
        this.send(
          clientSubscribe(deviceUid, {
            includeEvents: opts?.includeEvents ?? true,
            minLocationIntervalMs: opts?.minLocationIntervalMs,
          }),
        );
      } catch (e) {
        list.pop();
        reject(asError(e));
      }
    });
  }

  ackCommand(
    commandId: string,
    status: 'ok' | 'rejected' | 'failed' = 'ok',
    message?: string,
  ): void {
    if (this.isSocketOpen()) {
      this.send(clientCommandAck(commandId, status, message));
    }
  }

  async unsubscribe(deviceUid: string): Promise<void> {
    this.assertUsable();
    this.subscriptions.delete(deviceUid);
    if (this.isSocketOpen()) {
      this.send(clientUnsubscribe(deviceUid));
    }
  }

  ping(): void {
    if (this.isSocketOpen()) {
      this.send(clientPing());
    }
  }

  close(opts?: { code?: number; reason?: string }): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.setState('closed');
    this.rejectAllPending(new TrackingSdkError(ErrorCode.INVALID, 'client closed'));
    const sock = this.socket;
    this.socket = null;
    try {
      sock?.close(opts?.code ?? 1000, opts?.reason ?? 'client close');
    } catch {
      /* ignore */
    }
  }

  /** Initial dial used by `connect()`. */
  async open(): Promise<void> {
    this.intentionalClose = false;
    await this.dial(false);
  }

  private isSocketOpen(): boolean {
    return this._state === 'open' && this.socket?.readyState === WS_OPEN;
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.emit('state', state);
  }

  private emit<K extends keyof TrackingEvents>(
    event: K,
    ...args: Parameters<TrackingEvents[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const h of set) {
      try {
        (h as (...a: unknown[]) => void)(...args);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private assertUsable(): void {
    if (this.intentionalClose && this._state === 'closed') {
      throw new TrackingSdkError(ErrorCode.INVALID, 'client is closed');
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this._state === 'open') {
      return;
    }
    if (this.intentionalClose) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'client is closed');
    }
    await this.dial(Boolean(this._trackUid));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private send(msg: Parameters<typeof encodeClientMsg>[0]): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WS_OPEN) {
      throw new TrackingSdkError(ErrorCode.TRY_AGAIN, 'socket not open');
    }
    sock.send(encodeClientMsg(msg));
  }

  private async dial(sendResume: boolean): Promise<void> {
    this.clearReconnectTimer();
    const gen = ++this.dialGeneration;
    if (this._state === 'open' || this._state === 'reconnecting') {
      this.setState('reconnecting');
    } else {
      this.setState('connecting');
    }

    const Ctor = await resolveWebSocketCtor(this.WebSocketImpl);
    if (gen !== this.dialGeneration) {
      return;
    }

    const url = buildWsUrl(this.endpoint, this.auth, this.path);
    const sock = openSocket(Ctor, url);
    this.socket = sock;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(helloTimer);
        detachBootstrap();
        reject(err);
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      };

      const succeed = async () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(helloTimer);
        detachBootstrap();
        this.setState('open');
        resetBackoff(this.backoff);
        this.emit('open');
        this.attachRuntimeHandlers(sock, gen);
        try {
          await this.afterHello(sendResume);
          resolve();
        } catch (e) {
          reject(asError(e));
        }
      };

      const helloTimer = setTimeout(() => {
        fail(new TrackingSdkError(ErrorCode.TRY_AGAIN, 'hello timeout'));
      }, this.helloTimeoutMs);

      const onMessage = (ev: { data: unknown }) => {
        if (gen !== this.dialGeneration) {
          return;
        }
        let serverMsg: ServerMsg;
        try {
          serverMsg = decodeServerMsg(messageBytes(ev.data));
        } catch (e) {
          this.emit('error', asError(e));
          return;
        }

        if (!settled) {
          if (serverMsg.body.case === 'hello') {
            void succeed();
            return;
          }
          if (serverMsg.body.case === 'relocate') {
            settled = true;
            clearTimeout(helloTimer);
            detachBootstrap();
            void this.handleRelocate(serverMsg.body.value).then(resolve, reject);
            return;
          }
          if (serverMsg.body.case === 'error') {
            const err = TrackingSdkError.fromWire(serverMsg.body.value);
            this.emit('error', err);
            fail(err);
            return;
          }
        }
      };

      const onClose = (ev: { code?: number; reason?: string; wasClean?: boolean }) => {
        if (gen !== this.dialGeneration) {
          return;
        }
        if (!settled) {
          fail(
            new TrackingSdkError(
              ErrorCode.TRY_AGAIN,
              `socket closed before hello (${ev.code ?? 0})`,
            ),
          );
        }
        this.onSocketClosed(ev);
      };

      const onError = () => {
        /* close follows */
      };

      const detachBootstrap = () => {
        sock.removeEventListener('message', onMessage);
        sock.removeEventListener('close', onClose);
        sock.removeEventListener('error', onError);
      };

      sock.addEventListener('message', onMessage);
      sock.addEventListener('close', onClose);
      sock.addEventListener('error', onError);
    });
  }

  private attachRuntimeHandlers(sock: WebSocketLike, gen: number): void {
    const onMessage = (ev: { data: unknown }) => {
      if (gen !== this.dialGeneration || this.socket !== sock) {
        return;
      }
      try {
        this.dispatch(decodeServerMsg(messageBytes(ev.data)));
      } catch (e) {
        this.emit('error', asError(e));
      }
    };
    const onClose = (ev: { code?: number; reason?: string; wasClean?: boolean }) => {
      if (gen !== this.dialGeneration) {
        return;
      }
      this.onSocketClosed(ev);
    };
    sock.addEventListener('message', onMessage);
    sock.addEventListener('close', onClose);
  }

  private async afterHello(sendResume: boolean): Promise<void> {
    if (sendResume && this._trackUid) {
      await this.sendResumeAndWait();
    }
    for (const deviceUid of this.subscriptions) {
      try {
        this.send(clientSubscribe(deviceUid));
      } catch {
        /* retry on next open */
      }
    }
  }

  private sendResumeAndWait(): Promise<void> {
    const trackUid = this._trackUid!;
    return new Promise<void>((resolve, reject) => {
      this.resumeWaiters.push({ resolve, reject });
      try {
        this.send(clientResume(trackUid, this._clientSeq));
      } catch (e) {
        this.resumeWaiters.pop();
        reject(asError(e));
      }
    });
  }

  private flushQueue(): void {
    if (!this._trackUid || !this.isSocketOpen()) {
      return;
    }
    const pending = this.queue.peekAll();
    if (pending.length === 0) {
      return;
    }
    const points = pending.map((p) => p.point);
    const lastSeq = pending[pending.length - 1]!.seq;
    try {
      this.send(clientLocationBatch(this._trackUid, lastSeq, points));
    } catch {
      /* keep queued */
    }
  }

  private dispatch(msg: ServerMsg): void {
    const body = msg.body;
    switch (body.case) {
      case 'relocate':
        void this.handleRelocate(body.value);
        break;
      case 'resumeOk': {
        this._trackUid = body.value.trackUid || this._trackUid;
        this._lastAckedSeq = body.value.lastAckedSeq;
        if (this._clientSeq < this._lastAckedSeq) {
          this._clientSeq = this._lastAckedSeq;
        }
        this.queue.ackThrough(this._lastAckedSeq);
        this.emit('resumeOk', {
          trackUid: this._trackUid!,
          lastAckedSeq: this._lastAckedSeq,
        });
        this.flushQueue();
        for (const w of this.resumeWaiters.splice(0)) {
          w.resolve();
        }
        break;
      }
      case 'trackStarted': {
        this._trackUid = body.value.trackUid;
        this._clientSeq = 0n;
        this._lastAckedSeq = 0n;
        this.queue.clear();
        this.emit('trackStarted', body.value.trackUid);
        this.startWaiters.shift()?.resolve(body.value.trackUid);
        break;
      }
      case 'trackStopped': {
        const uid = body.value.trackUid;
        if (this._trackUid === uid) {
          this._trackUid = undefined;
          this.queue.clear();
        }
        this.emit('trackStopped', uid);
        this.stopWaiters.shift()?.resolve();
        break;
      }
      case 'locationAdded': {
        if (body.value.clientSeq > this._lastAckedSeq) {
          this._lastAckedSeq = body.value.clientSeq;
        }
        this.queue.ackThrough(body.value.clientSeq);
        this.emit('location', body.value);
        break;
      }
      case 'eventAdded': {
        this.emit('event', body.value);
        break;
      }
      case 'command': {
        this.emit('command', body.value);
        if (this.autoAckCommands && body.value.commandId) {
          this.ackCommand(body.value.commandId, 'ok');
        }
        break;
      }
      case 'devicePresence': {
        this.emit('presence', body.value);
        break;
      }
      case 'subscribed': {
        this.emit('subscribed', body.value);
        const waiters = this.subscribeWaiters.get(body.value.deviceUid);
        waiters?.shift()?.resolve(body.value);
        break;
      }
      case 'error': {
        const err = TrackingSdkError.fromWire(body.value);
        this.emit('error', err);
        if (this.resumeWaiters.length) {
          for (const w of this.resumeWaiters.splice(0)) {
            w.reject(err);
          }
          if (isFatalResumeError(err.code)) {
            this._trackUid = undefined;
            this.queue.clear();
          }
        }
        if (this.startWaiters.length) {
          for (const w of this.startWaiters.splice(0)) {
            w.reject(err);
          }
        }
        if (this.stopWaiters.length) {
          for (const w of this.stopWaiters.splice(0)) {
            w.reject(err);
          }
        }
        if (err.code === ErrorCode.AUTH || err.code === ErrorCode.UNAUTHORIZED) {
          void this.handleAuthError(err);
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleRelocate(info: {
    endpoint: string;
    retryAfterMs: number;
  }): Promise<void> {
    this.emit('relocate', info);
    if (info.endpoint) {
      this.endpoint = info.endpoint;
    }
    const delay = info.retryAfterMs ?? 0;
    try {
      this.socket?.close(4000, 'relocate');
    } catch {
      /* ignore */
    }
    this.socket = null;
    if (this.intentionalClose) {
      return;
    }
    await sleep(delay);
    await this.dial(Boolean(this._trackUid));
  }

  private async handleAuthError(err: TrackingSdkError): Promise<void> {
    if (!this.refreshAuth) {
      this.intentionalClose = true;
      this.setState('closed');
      return;
    }
    try {
      this.auth = await this.refreshAuth();
      if (this.intentionalClose) {
        return;
      }
      // Drop the rejected socket before redialing with fresh credentials.
      try {
        this.socket?.close(4000, 'auth refresh');
      } catch {
        /* ignore */
      }
      this.socket = null;
      await this.dial(Boolean(this._trackUid));
    } catch {
      this.emit('error', err);
      this.intentionalClose = true;
      this.setState('closed');
    }
  }

  private onSocketClosed(ev: {
    code?: number;
    reason?: string;
    wasClean?: boolean;
  }): void {
    this.socket = null;
    this.emit('close', {
      code: ev.code ?? 0,
      reason: typeof ev.reason === 'string' ? ev.reason : '',
      wasClean: Boolean(ev.wasClean),
    });

    if (this.intentionalClose) {
      this.setState('closed');
      return;
    }

    if (!this.reconnectEnabled) {
      this.setState('closed');
      this.rejectAllPending(
        new TrackingSdkError(ErrorCode.TRY_AGAIN, 'connection closed'),
      );
      return;
    }

    this.setState('reconnecting');
    const delay = nextDelayMs(this.backoff);
    if (delay === null) {
      this.setState('closed');
      this.rejectAllPending(
        new TrackingSdkError(ErrorCode.TRY_AGAIN, 'reconnect attempts exhausted'),
      );
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial(Boolean(this._trackUid)).catch((e) => {
        this.emit('error', asError(e));
        if (!this.intentionalClose && this._state !== 'open') {
          this.onSocketClosed({ code: 0, reason: 'dial failed', wasClean: false });
        }
      });
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const w of this.startWaiters.splice(0)) w.reject(err);
    for (const w of this.stopWaiters.splice(0)) w.reject(err);
    for (const w of this.resumeWaiters.splice(0)) w.reject(err);
    for (const [, list] of this.subscribeWaiters) {
      for (const w of list.splice(0)) w.reject(err);
    }
    this.subscribeWaiters.clear();
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export async function connect(config: TrackingConfig): Promise<TrackingClient> {
  const session = new TrackingSession(config);
  await session.open();
  return session;
}
