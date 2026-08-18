import {
  clientCommandAck,
  clientEvent,
  clientResume,
  clientSubscribe,
  clientTrackStart,
  clientTrackStop,
  clientUnsubscribe,
  decodeServerMsg,
  encodeClientMsg,
  encodeLocFrames,
  messageBytes,
  PROTOCOL_VERSION,
  toLatLng,
  toLiveLatLng,
} from './codec';
import {
  createBackoff,
  nextDelayMs,
  resetBackoff,
  type BackoffState,
} from './backoff';
import { TrackingSdkError } from './errors';
import { NoiseFilter } from './filter';
import { TrackBuffers } from './queue';
import {
  canAcceptPublish,
  MAX_EVENT_BYTES,
  MIN_EVENT_INTERVAL_MS,
  nextPublishAllowedAt,
} from './rate';
import { openSocket, resolveWebSocketCtor, WS_OPEN } from './socket';
import type {
  Auth,
  ClientMsg,
  ConnectionState,
  LatLng,
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
import { ErrorCode, isDeviceAuth, type Subscribed } from './types';
import { buildWsUrl, DEFAULT_TRACKING_PATH } from './url';

const MAX_IN_FLIGHT_FRAMES = 8;
const COALESCE_MS = 30;
const COALESCE_GAP_MS = 200;

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
  private readonly buffers: TrackBuffers;
  private readonly filter = new NoiseFilter();
  private unackedFrames = 0;
  private nextPublishAt = 0;
  private nextEventAt = 0;
  private lastLiveEmitAt = 0;
  private pendingSend: { seq: number; point: LatLngInput }[] = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff: BackoffState;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private dialGeneration = 0;
  private readonly wantedDevices = new Set<string>();
  private readonly subByDevice = new Map<string, number>();
  private readonly deviceBySub = new Map<number, string>();
  private readonly listeners = new Map<keyof TrackingEvents, Set<Function>>();

  private startWaiters: Pending<string>[] = [];
  private stopWaiters: Pending<void>[] = [];
  private subscribeWaiters = new Map<string, Pending<Subscribed>[]>();
  private resumeWaiters: Pending<void>[] = [];
  private starting = false;

  constructor(config: TrackingConfig) {
    this.endpoint = config.endpoint;
    this.auth = config.auth;
    this.path = config.path ?? DEFAULT_TRACKING_PATH;
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

    this.buffers = new TrackBuffers(config.maxQueueSize ?? 10_000, (dropped) => {
      this.emit('queueGap', dropped);
    });
    const initial = config.subscribe;
    if (typeof initial === 'string' && initial) {
      this.wantedDevices.add(initial);
    } else if (Array.isArray(initial)) {
      for (const id of initial) {
        if (id) this.wantedDevices.add(id);
      }
    }
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
    this.resetTrackLocal();
    this.starting = true;
    await this.ensureOpen();
    return new Promise<string>((resolve, reject) => {
      this.startWaiters.push({ resolve, reject });
      try {
        this.send(clientTrackStart(opts.location, opts.route, opts.metadata));
      } catch (e) {
        this.startWaiters.pop();
        this.starting = false;
        reject(asError(e));
      }
    });
  }

  async stopTrack(_trackUid?: string): Promise<void> {
    this.assertUsable();
    if (!this._trackUid) {
      throw new TrackingSdkError(ErrorCode.INVALID, 'no active track');
    }
    await this.ensureOpen();
    return new Promise<void>((resolve, reject) => {
      this.stopWaiters.push({ resolve, reject });
      try {
        this.send(clientTrackStop());
      } catch (e) {
        this.stopWaiters.pop();
        reject(asError(e));
      }
    });
  }

  publish(point: LatLngInput): bigint {
    this.assertUsable();
    if (!this._trackUid && !this.starting) {
      this.starting = true;
      this.resetTrackLocal();
      try {
        this.send(clientTrackStart(point));
      } catch {
        this.starting = false;
      }
      return this._clientSeq;
    }
    if (!this.tryAcceptPublish(1)) {
      return this._clientSeq;
    }
    const emitted = this.filter.push(point);
    if (!emitted) {
      return this._clientSeq;
    }
    this.acceptFiltered(emitted);
    return this._clientSeq;
  }

  publishBatch(points: LatLngInput[]): bigint {
    this.assertUsable();
    for (const p of points) {
      if (!this.tryAcceptPublish(1)) {
        break;
      }
      const emitted = this.filter.push(p);
      if (emitted) {
        this.acceptFiltered(emitted);
      }
    }
    return this._clientSeq;
  }

  private tryAcceptPublish(pointCount: number): boolean {
    const now = Date.now();
    if (!canAcceptPublish(this.nextPublishAt, now, pointCount)) {
      return false;
    }
    this.nextPublishAt = nextPublishAllowedAt(this.nextPublishAt, now, pointCount);
    return true;
  }

  private acceptFiltered(point: LatLngInput): void {
    const captured = capturePoint(point);
    if (!this.canSendLoc()) {
      this.buffers.stage(captured);
      return;
    }
    // Seq is assigned when the filtered point leaves for InFlight (open socket).
    const assigned = this.assignToInFlight([captured]);
    const now = Date.now();
    this.pendingSend.push(...assigned);
    if (now - this.lastLiveEmitAt >= COALESCE_GAP_MS) {
      this.flushPendingSend(true);
      return;
    }
    if (this.coalesceTimer === null) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.flushPendingSend(true);
      }, COALESCE_MS);
    }
  }

  private flushPendingSend(live: boolean): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const batch = this.pendingSend.splice(0);
    if (batch.length === 0) {
      return;
    }
    if (!this.isSocketOpen()) {
      return;
    }
    this.sendAssigned(batch, live);
    this.lastLiveEmitAt = Date.now();
  }

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
      this.send(clientEvent(bytes));
    }
    return true;
  }

  async subscribe(
    deviceUid: string,
    opts?: SubscribeOptions,
  ): Promise<Subscribed> {
    this.assertUsable();
    await this.ensureOpen();
    this.wantedDevices.add(deviceUid);
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
    this.wantedDevices.delete(deviceUid);
    const sub = this.subByDevice.get(deviceUid);
    this.subByDevice.delete(deviceUid);
    if (sub !== undefined) {
      this.deviceBySub.delete(sub);
      if (this.isSocketOpen()) {
        this.send(clientUnsubscribe(sub));
      }
    }
  }

  close(opts?: { code?: number; reason?: string }): void {
    if ((this._trackUid || this.starting) && this.isSocketOpen()) {
      try {
        this.send(clientTrackStop());
      } catch {
        /* best-effort */
      }
    }
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearResumeRetry();
    this.clearCoalesce();
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

  async open(): Promise<void> {
    this.intentionalClose = false;
    await this.dial(false);
  }

  private isSocketOpen(): boolean {
    return this._state === 'open' && this.socket?.readyState === WS_OPEN;
  }

  private canSendLoc(): boolean {
    return this.isSocketOpen() && !!this._trackUid && this.unackedFrames < MAX_IN_FLIGHT_FRAMES;
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

  private clearResumeRetry(): void {
    if (this.resumeRetryTimer !== null) {
      clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = null;
    }
  }

  private clearCoalesce(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    // Already sequenced into InFlight; Resume will resend. Unsequenced live
    // points never sit here — those go to Staging in acceptFiltered.
    this.pendingSend = [];
  }

  private send(msg: ClientMsg): void {
    this.sendRaw(encodeClientMsg(msg));
  }

  private sendRaw(bytes: Uint8Array): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WS_OPEN) {
      throw new TrackingSdkError(ErrorCode.TRY_AGAIN, 'socket not open');
    }
    sock.send(bytes);
  }

  private async dial(sendResume: boolean): Promise<void> {
    this.clearReconnectTimer();
    this.clearResumeRetry();
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
    this.unackedFrames = 0;
    this.subByDevice.clear();
    this.deviceBySub.clear();

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
        let serverMsg;
        try {
          serverMsg = decodeServerMsg(messageBytes(ev.data));
        } catch (e) {
          this.emit('error', asError(e));
          return;
        }
        if (!serverMsg) {
          return;
        }

        if (!settled) {
          if (serverMsg.type === 'hello') {
            if (serverMsg.version !== PROTOCOL_VERSION) {
              fail(
                new TrackingSdkError(
                  ErrorCode.INVALID,
                  `unsupported protocol version ${serverMsg.version}`,
                ),
              );
              try {
                sock.close(1002, 'unsupported version');
              } catch {
                /* ignore */
              }
              return;
            }
            void succeed();
            return;
          }
          if (serverMsg.type === 'relocate') {
            settled = true;
            clearTimeout(helloTimer);
            detachBootstrap();
            void this.handleRelocate(serverMsg).then(resolve, reject);
            return;
          }
          if (serverMsg.type === 'error') {
            const err = TrackingSdkError.fromWire(serverMsg);
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
        const msg = decodeServerMsg(messageBytes(ev.data));
        if (msg) {
          this.dispatch(msg);
        }
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
    for (const deviceUid of this.wantedDevices) {
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

  private retryResume(delayMs: number): void {
    this.clearResumeRetry();
    this.resumeRetryTimer = setTimeout(() => {
      this.resumeRetryTimer = null;
      if (!this.isSocketOpen() || !this._trackUid || this.resumeWaiters.length === 0) {
        return;
      }
      try {
        this.send(clientResume(this._trackUid, this._clientSeq));
      } catch (e) {
        for (const w of this.resumeWaiters.splice(0)) {
          w.reject(asError(e));
        }
      }
    }, Math.max(0, delayMs));
  }

  private assignToInFlight(
    points: LatLngInput[],
  ): { seq: number; point: LatLngInput }[] {
    const assigned: { seq: number; point: LatLngInput }[] = [];
    for (const p of points) {
      this._clientSeq += 1n;
      const seq = Number(this._clientSeq);
      this.buffers.addInFlight(seq, p);
      assigned.push({ seq, point: p });
    }
    return assigned;
  }

  private assignAndSend(points: LatLngInput[], live: boolean): void {
    if (points.length === 0) {
      return;
    }
    this.sendAssigned(this.assignToInFlight(points), live);
  }

  private sendAssigned(
    assigned: { seq: number; point: LatLngInput }[],
    live: boolean,
  ): void {
    if (assigned.length === 0 || !this.isSocketOpen()) {
      return;
    }
    const lastSeq = assigned[assigned.length - 1]!.seq;
    const wire: LatLng[] = assigned.map((a) =>
      live ? toLiveLatLng(a.point) : toLatLng(a.point),
    );
    const frames = encodeLocFrames(lastSeq, wire);
    for (const frame of frames) {
      if (this.unackedFrames >= MAX_IN_FLIGHT_FRAMES) {
        break;
      }
      try {
        this.sendRaw(frame);
        this.unackedFrames += 1;
      } catch {
        break;
      }
    }
  }

  /** Resend remaining InFlight, then assign seq to Staging and send. */
  private flushAfterResume(): void {
    if (!this._trackUid || !this.isSocketOpen()) {
      return;
    }
    const inflight = [...this.buffers.peekInFlight()];
    if (inflight.length > 0) {
      this.sendAssigned(inflight, false);
    }
    this.drainStaging();
  }

  private drainStaging(): void {
    if (!this.canSendLoc()) {
      return;
    }
    while (this.buffers.stagingSize > 0 && this.canSendLoc()) {
      const take = Math.min(100, this.buffers.stagingSize);
      const points = this.buffers.takeStaging(take);
      this.assignAndSend(points, false);
    }
  }

  private resetTrackLocal(): void {
    this._trackUid = undefined;
    this._clientSeq = 0n;
    this._lastAckedSeq = 0n;
    this.buffers.clear();
    this.filter.reset();
    this.clearCoalesce();
    this.unackedFrames = 0;
  }

  private deviceUidForSub(sub: number): string {
    return this.deviceBySub.get(sub) ?? '';
  }

  private dispatch(msg: ReturnType<typeof decodeServerMsg> & {}): void {
    switch (msg.type) {
      case 'relocate':
        void this.handleRelocate(msg);
        break;
      case 'resumeOk': {
        this.clearResumeRetry();
        this._trackUid = msg.trackUid || this._trackUid;
        this._lastAckedSeq = BigInt(msg.lastAckedSeq);
        if (this._clientSeq < this._lastAckedSeq) {
          this._clientSeq = this._lastAckedSeq;
        }
        this.buffers.ackThrough(msg.lastAckedSeq);
        this.unackedFrames = 0;
        this.emit('resumeOk', {
          trackUid: this._trackUid!,
          lastAckedSeq: this._lastAckedSeq,
        });
        this.flushAfterResume();
        for (const w of this.resumeWaiters.splice(0)) {
          w.resolve();
        }
        break;
      }
      case 'trackStarted': {
        this._trackUid = msg.trackUid;
        this._clientSeq = 0n;
        this._lastAckedSeq = 0n;
        this.starting = false;
        this.emit('trackStarted', msg.trackUid);
        this.startWaiters.shift()?.resolve(msg.trackUid);
        this.drainStaging();
        break;
      }
      case 'trackStopped': {
        const uid = msg.trackUid;
        if (this._trackUid === uid) {
          this._trackUid = undefined;
          this.buffers.clear();
          this.filter.reset();
        }
        this.emit('trackStopped', uid);
        this.stopWaiters.shift()?.resolve();
        break;
      }
      case 'ack': {
        this._lastAckedSeq = BigInt(msg.seq);
        this.buffers.ackThrough(msg.seq);
        this.unackedFrames = 0;
        this.drainStaging();
        break;
      }
      case 'loc': {
        this.emit('location', {
          sub: msg.sub,
          deviceUid: this.deviceUidForSub(msg.sub),
          seq: BigInt(msg.seq),
          point: msg.point,
        });
        break;
      }
      case 'eventAdded': {
        this.emit('event', {
          sub: msg.sub,
          deviceUid: this.deviceUidForSub(msg.sub),
          payload: msg.payload,
          timestampMs: msg.timestampMs,
        });
        break;
      }
      case 'command': {
        this.emit('command', {
          commandId: msg.commandId,
          payload: msg.payload,
          timestampMs: msg.timestampMs,
        });
        if (this.autoAckCommands && msg.commandId) {
          this.ackCommand(msg.commandId, 'ok');
        }
        break;
      }
      case 'presence': {
        this.emit('presence', {
          sub: msg.sub,
          deviceUid: this.deviceUidForSub(msg.sub),
          online: msg.online,
          lastSeenMs: msg.lastSeenMs,
        });
        break;
      }
      case 'subscribed': {
        const snap: Subscribed = {
          sub: msg.sub,
          deviceUid: msg.deviceUid,
          trackUid: msg.trackUid,
          online: msg.online,
          lastLocation: msg.lastLocation,
          lastSeenMs: msg.lastSeenMs,
          route: msg.route,
          estimatedDistance: msg.estimatedDistance,
          estimatedDuration: msg.estimatedDuration,
          startLocationName: msg.startLocationName,
          endLocationName: msg.endLocationName,
          metadata: msg.metadata,
        };
        this.subByDevice.set(snap.deviceUid, snap.sub);
        this.deviceBySub.set(snap.sub, snap.deviceUid);
        this.emit('subscribed', snap);
        this.subscribeWaiters.get(snap.deviceUid)?.shift()?.resolve(snap);
        break;
      }
      case 'error': {
        const err = TrackingSdkError.fromWire(msg);
        this.emit('error', err);
        if (this.resumeWaiters.length) {
          if (msg.code === ErrorCode.FENCED || msg.code === ErrorCode.TRY_AGAIN) {
            this.retryResume(msg.retryAfterMs ?? 200);
            break;
          }
          for (const w of this.resumeWaiters.splice(0)) {
            w.reject(err);
          }
          if (msg.code === ErrorCode.TRACK_NOT_FOUND) {
            this.resetTrackLocal();
            this.starting = false;
          }
        }
        if (this.startWaiters.length) {
          this.starting = false;
          for (const w of this.startWaiters.splice(0)) {
            w.reject(err);
          }
        }
        if (this.stopWaiters.length) {
          for (const w of this.stopWaiters.splice(0)) {
            w.reject(err);
          }
        }
        if (
          !this.resumeWaiters.length &&
          msg.code === ErrorCode.TRACK_NOT_FOUND &&
          this._trackUid
        ) {
          this.resetTrackLocal();
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
    this.unackedFrames = 0;
    this.clearCoalesce();
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
    this.starting = false;
    for (const w of this.startWaiters.splice(0)) w.reject(err);
    for (const w of this.stopWaiters.splice(0)) w.reject(err);
    for (const w of this.resumeWaiters.splice(0)) w.reject(err);
    for (const [, list] of this.subscribeWaiters) {
      for (const w of list.splice(0)) w.reject(err);
    }
    this.subscribeWaiters.clear();
  }
}

function capturePoint(point: LatLngInput): LatLngInput {
  return {
    ...point,
    timestampMs:
      point.timestampMs === undefined
        ? Date.now()
        : typeof point.timestampMs === 'bigint'
          ? Number(point.timestampMs)
          : point.timestampMs,
  };
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
