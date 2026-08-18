import {
  CommandAckStatus,
  ErrorCode,
  type ClientMsg,
  type LatLng,
  type LatLngInput,
  type ServerMsg,
  type Subscribed,
} from './types';

export const PROTOCOL_VERSION = 2;
export const MAX_STRING = 4096;
export const MAX_LOC_POINTS = 100;

export const C_RESUME = 0x01;
export const C_TRACK_START = 0x02;
export const C_TRACK_STOP = 0x03;
export const C_LOC = 0x04;
export const C_SUBSCRIBE = 0x05;
export const C_UNSUBSCRIBE = 0x06;
export const C_EVENT = 0x07;
export const C_COMMAND_ACK = 0x08;

export const S_HELLO = 0x80;
export const S_RELOCATE = 0x81;
export const S_RESUME_OK = 0x82;
export const S_TRACK_STARTED = 0x83;
export const S_TRACK_STOPPED = 0x84;
export const S_ACK = 0x85;
export const S_LOC = 0x86;
export const S_SUBSCRIBED = 0x87;
export const S_ERROR = 0x88;
export const S_EVENT_ADDED = 0x89;
export const S_COMMAND = 0x8a;
export const S_PRESENCE = 0x8b;

const PF_ALT = 1 << 0;
const PF_ACC = 1 << 1;
const PF_TIME = 1 << 4;

const LAT_MIN = -90_000_000;
const LAT_MAX = 90_000_000;
const LON_MIN = -180_000_000;
const LON_MAX = 180_000_000;

const I16_MIN = -32768;
const I16_MAX = 32767;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeError';
  }
}

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private o = 0;

  private ensure(n: number): void {
    if (this.o + n <= this.buf.length) {
      return;
    }
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.o + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.o, v);
    this.o += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.o, v, true);
    this.o += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }

  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.o, v, true);
    this.o += 2;
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.o, v, true);
    this.o += 4;
  }

  i64(v: number | bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.o, typeof v === 'bigint' ? v : BigInt(Math.trunc(v)), true);
    this.o += 8;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.o, v, true);
    this.o += 8;
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.o);
    this.o += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.o);
  }
}

class Reader {
  private readonly view: DataView;
  private o = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.view.byteLength - this.o;
  }

  private need(n: number): void {
    if (this.o + n > this.view.byteLength) {
      throw new DecodeError('truncated frame');
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.o);
    this.o += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.o, true);
    this.o += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.o, true);
    this.o += 4;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.o, true);
    this.o += 8;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }

  uuid(): string {
    this.need(16);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.o, 16);
    this.o += 16;
    return formatUuid(bytes);
  }

  uuidOpt(): string | undefined {
    const id = this.uuid();
    return isNilUuid(id) ? undefined : id;
  }

  str(): string {
    const n = this.u16();
    if (n > MAX_STRING) {
      throw new DecodeError('invalid frame');
    }
    this.need(n);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.o, n);
    this.o += n;
    return new TextDecoder().decode(bytes);
  }

  bytes(): Uint8Array {
    const n = this.u16();
    if (n > MAX_STRING) {
      throw new DecodeError('invalid frame');
    }
    this.need(n);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.o, n);
    this.o += n;
    return bytes.slice();
  }
}

export function degToMicro(d: number): number {
  return Math.round(d * 1_000_000);
}

export function microToDeg(m: number): number {
  return m / 1_000_000;
}

export function microDeltaFits(
  prevLat: number,
  prevLon: number,
  lat: number,
  lon: number,
): boolean {
  const dlat = lat - prevLat;
  const dlon = lon - prevLon;
  return dlat >= I16_MIN && dlat <= I16_MAX && dlon >= I16_MIN && dlon <= I16_MAX;
}

export function parseUuidBytes(s: string): Uint8Array {
  if (!s) {
    return new Uint8Array(16);
  }
  const hex = s.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) {
    return new Uint8Array(16);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isNilUuid(s: string): boolean {
  return parseUuidBytes(s).every((b) => b === 0);
}

function putUuid(w: Writer, s: string): void {
  w.raw(parseUuidBytes(s));
}

function putStr(w: Writer, s: string): void {
  const bytes = new TextEncoder().encode(s);
  const n = Math.min(bytes.length, MAX_STRING);
  w.u16(n);
  w.raw(bytes.subarray(0, n));
}

function putBytes(w: Writer, b: Uint8Array): void {
  const n = Math.min(b.length, MAX_STRING);
  w.u16(n);
  w.raw(b.subarray(0, n));
}

function checkCoord(lat: number, lon: number): void {
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
    throw new DecodeError('invalid frame');
  }
}

function timestampMsOf(p: LatLng): number | undefined {
  return p.timestampMs;
}

function writePoint(
  w: Writer,
  p: LatLng,
  prev: [number, number] | undefined,
): [number, number] {
  const lat = degToMicro(p.latitude);
  const lon = degToMicro(p.longitude);
  let flags = 0;
  if (p.altitude !== undefined) {
    flags |= PF_ALT;
  }
  if (p.accuracy !== undefined) {
    flags |= PF_ACC;
  }
  if (timestampMsOf(p) !== undefined) {
    flags |= PF_TIME;
  }
  w.u8(flags);
  if (prev) {
    if (!microDeltaFits(prev[0], prev[1], lat, lon)) {
      throw new EncodeError('intra-frame delta overflows i16');
    }
    w.i16(lat - prev[0]);
    w.i16(lon - prev[1]);
  } else {
    w.i32(lat);
    w.i32(lon);
  }
  if (p.altitude !== undefined) {
    w.i32(Math.round(p.altitude * 1000));
  }
  if (p.accuracy !== undefined) {
    const cm = Math.round(p.accuracy * 100);
    w.u16(Math.max(0, Math.min(0xffff, cm)));
  }
  const ts = timestampMsOf(p);
  if (ts !== undefined) {
    w.i64(ts);
  }
  return [lat, lon];
}

function writeAbs(w: Writer, p: LatLng): void {
  writePoint(w, p, undefined);
}

function writeRouteAbs(w: Writer, route: LatLng[]): void {
  const n = Math.min(route.length, 0xffff);
  w.u16(n);
  for (let i = 0; i < n; i++) {
    const p = route[i]!;
    w.i32(degToMicro(p.latitude));
    w.i32(degToMicro(p.longitude));
  }
}

function readPoint(r: Reader, prev: [number, number] | undefined): {
  point: LatLng;
  lat: number;
  lon: number;
} {
  const flags = r.u8();
  let lat: number;
  let lon: number;
  if (prev) {
    lat = prev[0] + r.i16();
    lon = prev[1] + r.i16();
  } else {
    lat = r.i32();
    lon = r.i32();
  }
  checkCoord(lat, lon);
  const point: LatLng = {
    latitude: microToDeg(lat),
    longitude: microToDeg(lon),
  };
  if (flags & PF_ALT) {
    point.altitude = r.i32() / 1000;
  }
  if (flags & PF_ACC) {
    point.accuracy = r.u16() / 100;
  }
  if (flags & PF_TIME) {
    point.timestampMs = Number(r.i64());
  }
  return { point, lat, lon };
}

function readRouteAbs(r: Reader): LatLng[] {
  const n = r.u16();
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const lat = r.i32();
    const lon = r.i32();
    checkCoord(lat, lon);
    out.push({ latitude: microToDeg(lat), longitude: microToDeg(lon) });
  }
  return out;
}

export function toLatLng(input: LatLngInput): LatLng {
  const out: LatLng = {
    latitude: input.latitude,
    longitude: input.longitude,
  };
  if (input.altitude !== undefined) {
    out.altitude = input.altitude;
  }
  if (input.accuracy !== undefined) {
    out.accuracy = input.accuracy;
  }
  if (input.timestampMs !== undefined) {
    out.timestampMs =
      typeof input.timestampMs === 'bigint'
        ? Number(input.timestampMs)
        : input.timestampMs;
  }
  return out;
}

/** Live Loc omits timestamp so the server stamps ingest time. */
export function toLiveLatLng(input: LatLngInput): LatLng {
  const p = toLatLng(input);
  delete p.timestampMs;
  return p;
}

export function encodeLocFrames(lastSeq: number, points: LatLng[]): Uint8Array[] {
  if (points.length === 0) {
    return [];
  }
  const n = points.length;
  const firstSeq = lastSeq + 1 - n;
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < points.length) {
    const start = i;
    let prev: [number, number] = [
      degToMicro(points[i]!.latitude),
      degToMicro(points[i]!.longitude),
    ];
    i += 1;
    while (i < points.length && i - start < MAX_LOC_POINTS) {
      const lat = degToMicro(points[i]!.latitude);
      const lon = degToMicro(points[i]!.longitude);
      if (!microDeltaFits(prev[0], prev[1], lat, lon)) {
        break;
      }
      prev = [lat, lon];
      i += 1;
    }
    const chunk = points.slice(start, i);
    const seq = firstSeq + i - 1;
    out.push(encodeLocFrame(seq, chunk));
  }
  return out;
}

function encodeLocFrame(seq: number, points: LatLng[]): Uint8Array {
  const w = new Writer();
  w.u8(C_LOC);
  w.u32(seq);
  w.u8(points.length);
  let prev: [number, number] | undefined;
  for (const p of points) {
    prev = writePoint(w, p, prev);
  }
  return w.finish();
}

export function encodeClientMsg(msg: ClientMsg): Uint8Array {
  const w = new Writer();
  switch (msg.type) {
    case 'resume':
      w.u8(C_RESUME);
      putUuid(w, msg.trackUid);
      w.u32(msg.lastSeq);
      break;
    case 'trackStart': {
      w.u8(C_TRACK_START);
      let flags = 0;
      if (msg.location) {
        flags |= 1;
      }
      w.u8(flags);
      if (msg.location) {
        writeAbs(w, msg.location);
      }
      writeRouteAbs(w, msg.route);
      putBytes(w, msg.metadata);
      break;
    }
    case 'trackStop':
      w.u8(C_TRACK_STOP);
      break;
    case 'loc': {
      const frames = encodeLocFrames(msg.seq, msg.points);
      if (frames.length === 0) {
        throw new EncodeError('empty loc');
      }
      return frames[0]!;
    }
    case 'subscribe':
      w.u8(C_SUBSCRIBE);
      putUuid(w, msg.deviceUid);
      w.u8(msg.includeEvents ? 1 : 0);
      w.u16(Math.min(msg.minIntervalMs, 0xffff));
      break;
    case 'unsubscribe':
      w.u8(C_UNSUBSCRIBE);
      w.u8(msg.sub);
      break;
    case 'event':
      w.u8(C_EVENT);
      putBytes(w, msg.payload);
      w.i64(msg.timestampMs);
      break;
    case 'commandAck':
      w.u8(C_COMMAND_ACK);
      putUuid(w, msg.commandId);
      w.u8(msg.status);
      putStr(w, msg.message);
      break;
  }
  return w.finish();
}

export function decodeClientMsg(bytes: Uint8Array): ClientMsg {
  if (bytes.length === 0) {
    throw new DecodeError('truncated frame');
  }
  const r = new Reader(bytes);
  const typ = r.u8();
  switch (typ) {
    case C_RESUME:
      return { type: 'resume', trackUid: r.uuid(), lastSeq: r.u32() };
    case C_TRACK_START: {
      const flags = r.u8();
      const location = flags & 1 ? readPoint(r, undefined).point : undefined;
      const route = readRouteAbs(r);
      const metadata = r.bytes();
      return { type: 'trackStart', location, route, metadata };
    }
    case C_TRACK_STOP:
      return { type: 'trackStop' };
    case C_LOC: {
      const seq = r.u32();
      const count = r.u8();
      if (count === 0 || count > MAX_LOC_POINTS) {
        throw new DecodeError('invalid frame');
      }
      const points: LatLng[] = [];
      let prev: [number, number] | undefined;
      for (let i = 0; i < count; i++) {
        const got = readPoint(r, prev);
        points.push(got.point);
        prev = [got.lat, got.lon];
      }
      return { type: 'loc', seq, points };
    }
    case C_SUBSCRIBE:
      return {
        type: 'subscribe',
        deviceUid: r.uuid(),
        includeEvents: (r.u8() & 1) !== 0,
        minIntervalMs: r.u16(),
      };
    case C_UNSUBSCRIBE:
      return { type: 'unsubscribe', sub: r.u8() };
    case C_EVENT: {
      const payload = r.bytes();
      const t = Number(r.i64());
      return { type: 'event', payload, timestampMs: t };
    }
    case C_COMMAND_ACK:
      return {
        type: 'commandAck',
        commandId: r.uuid(),
        status: r.u8() as CommandAckStatus,
        message: r.str(),
      };
    case 0x00:
    case 0x7f:
    case 0xff:
      throw new DecodeError('invalid frame');
    default:
      throw new DecodeError('invalid frame');
  }
}

export function encodeServerMsg(msg: ServerMsg): Uint8Array {
  const w = new Writer();
  switch (msg.type) {
    case 'hello':
      w.u8(S_HELLO);
      w.u8(msg.version);
      w.u16(msg.shard);
      putUuid(w, msg.nodeId);
      break;
    case 'relocate':
      w.u8(S_RELOCATE);
      w.u32(msg.retryAfterMs);
      putStr(w, msg.endpoint);
      break;
    case 'resumeOk':
      w.u8(S_RESUME_OK);
      putUuid(w, msg.trackUid);
      w.u32(msg.lastAckedSeq);
      break;
    case 'trackStarted':
      w.u8(S_TRACK_STARTED);
      putUuid(w, msg.trackUid);
      putBytes(w, msg.metadata);
      break;
    case 'trackStopped':
      w.u8(S_TRACK_STOPPED);
      putUuid(w, msg.trackUid);
      break;
    case 'ack':
      w.u8(S_ACK);
      w.u32(msg.seq);
      break;
    case 'loc':
      w.u8(S_LOC);
      w.u8(msg.sub);
      w.u32(msg.seq);
      writeAbs(w, msg.point);
      break;
    case 'subscribed': {
      w.u8(S_SUBSCRIBED);
      w.u8(msg.sub);
      putUuid(w, msg.deviceUid);
      putUuid(w, msg.trackUid);
      w.u8(msg.online ? 1 : 0);
      let flags = 0;
      if (msg.lastLocation) {
        flags |= 1;
      }
      if (msg.lastSeenMs !== undefined) {
        flags |= 2;
      }
      if (msg.route.length) {
        flags |= 4;
      }
      w.u8(flags);
      if (msg.lastLocation) {
        writeAbs(w, msg.lastLocation);
      }
      if (msg.lastSeenMs !== undefined) {
        w.i64(msg.lastSeenMs);
      }
      if (flags & 4) {
        writeRouteAbs(w, msg.route);
      }
      w.f64(msg.estimatedDistance);
      w.f64(msg.estimatedDuration);
      putStr(w, msg.startLocationName);
      putStr(w, msg.endLocationName);
      putBytes(w, msg.metadata);
      break;
    }
    case 'error':
      w.u8(S_ERROR);
      w.u8(msg.code);
      w.u32(msg.retryAfterMs ?? 0);
      putUuid(w, msg.trackUid ?? '');
      putStr(w, msg.message);
      break;
    case 'eventAdded':
      w.u8(S_EVENT_ADDED);
      w.u8(msg.sub);
      putBytes(w, msg.payload);
      w.i64(msg.timestampMs ?? 0);
      break;
    case 'command':
      w.u8(S_COMMAND);
      putUuid(w, msg.commandId);
      putBytes(w, msg.payload);
      w.i64(msg.timestampMs ?? 0);
      break;
    case 'presence':
      w.u8(S_PRESENCE);
      w.u8(msg.sub);
      w.u8(msg.online ? 1 : 0);
      w.i64(msg.lastSeenMs ?? 0);
      break;
  }
  return w.finish();
}

/** `null` = unknown server type (ignore, forward-compat). */
export function decodeServerMsg(bytes: Uint8Array): ServerMsg | null {
  if (bytes.length === 0) {
    throw new DecodeError('truncated frame');
  }
  const r = new Reader(bytes);
  const typ = r.u8();
  switch (typ) {
    case S_HELLO:
      return { type: 'hello', version: r.u8(), shard: r.u16(), nodeId: r.uuid() };
    case S_RELOCATE:
      return { type: 'relocate', retryAfterMs: r.u32(), endpoint: r.str() };
    case S_RESUME_OK:
      return { type: 'resumeOk', trackUid: r.uuid(), lastAckedSeq: r.u32() };
    case S_TRACK_STARTED:
      return { type: 'trackStarted', trackUid: r.uuid(), metadata: r.bytes() };
    case S_TRACK_STOPPED:
      return { type: 'trackStopped', trackUid: r.uuid() };
    case S_ACK:
      return { type: 'ack', seq: r.u32() };
    case S_LOC: {
      const sub = r.u8();
      const seq = r.u32();
      const { point } = readPoint(r, undefined);
      return { type: 'loc', sub, seq, point };
    }
    case S_SUBSCRIBED: {
      const sub = r.u8();
      const deviceUid = r.uuid();
      const trackUid = r.uuidOpt() ?? '';
      const online = r.u8() !== 0;
      const flags = r.u8();
      const lastLocation = flags & 1 ? readPoint(r, undefined).point : undefined;
      const lastSeenMs = flags & 2 ? Number(r.i64()) : undefined;
      const route = flags & 4 ? readRouteAbs(r) : [];
      const estimatedDistance = r.f64();
      const estimatedDuration = r.f64();
      const startLocationName = r.str();
      const endLocationName = r.str();
      const metadata = r.bytes();
      const snap: Subscribed = {
        sub,
        deviceUid,
        trackUid,
        online,
        lastLocation,
        lastSeenMs,
        route,
        estimatedDistance,
        estimatedDuration,
        startLocationName,
        endLocationName,
        metadata,
      };
      return { type: 'subscribed', ...snap };
    }
    case S_ERROR: {
      const code = r.u8() as ErrorCode;
      if (code < 1 || code > 6) {
        throw new DecodeError('invalid frame');
      }
      const retry = r.u32();
      const trackUid = r.uuidOpt();
      const message = r.str();
      return {
        type: 'error',
        code,
        message,
        trackUid,
        retryAfterMs: retry === 0 ? undefined : retry,
      };
    }
    case S_EVENT_ADDED: {
      const sub = r.u8();
      const payload = r.bytes();
      const t = Number(r.i64());
      return {
        type: 'eventAdded',
        sub,
        payload,
        timestampMs: t === 0 ? undefined : t,
      };
    }
    case S_COMMAND: {
      const commandId = r.uuid();
      const payload = r.bytes();
      const t = Number(r.i64());
      return {
        type: 'command',
        commandId,
        payload,
        timestampMs: t === 0 ? undefined : t,
      };
    }
    case S_PRESENCE: {
      const sub = r.u8();
      const online = r.u8() !== 0;
      const t = Number(r.i64());
      return {
        type: 'presence',
        sub,
        online,
        lastSeenMs: t === 0 ? undefined : t,
      };
    }
    case 0x00:
    case 0x7f:
    case 0xff:
    case 0x8c:
      throw new DecodeError('invalid frame');
    default:
      if (typ >= 0x80 && typ <= 0xfe) {
        return null;
      }
      throw new DecodeError('invalid frame');
  }
}

export function clientResume(trackUid: string, lastSeq: number | bigint): ClientMsg {
  return { type: 'resume', trackUid, lastSeq: Number(lastSeq) };
}

export function clientTrackStart(
  location?: LatLngInput,
  route?: LatLngInput[],
  metadata?: Uint8Array,
): ClientMsg {
  return {
    type: 'trackStart',
    location: location ? toLatLng(location) : undefined,
    route: (route ?? []).map(toLatLng),
    metadata: metadata ?? new Uint8Array(),
  };
}

export function clientTrackStop(): ClientMsg {
  return { type: 'trackStop' };
}

export function clientLoc(seq: number | bigint, points: LatLngInput[]): ClientMsg {
  return { type: 'loc', seq: Number(seq), points: points.map(toLatLng) };
}

export function clientLocationAdd(
  _trackUid: string,
  clientSeq: bigint,
  point: LatLngInput,
): ClientMsg {
  return clientLoc(clientSeq, [point]);
}

export function clientLocationBatch(
  _trackUid: string,
  clientSeq: bigint,
  points: LatLngInput[],
): ClientMsg {
  return clientLoc(clientSeq, points);
}

export function clientSubscribe(
  deviceUid: string,
  opts?: { includeEvents?: boolean; minLocationIntervalMs?: number },
): ClientMsg {
  return {
    type: 'subscribe',
    deviceUid,
    includeEvents: opts?.includeEvents ?? true,
    minIntervalMs: opts?.minLocationIntervalMs ?? 0,
  };
}

export function clientUnsubscribe(sub: number): ClientMsg {
  return { type: 'unsubscribe', sub };
}

export function clientEvent(
  payload: Uint8Array,
  timestampMs?: number | bigint,
): ClientMsg {
  return {
    type: 'event',
    payload,
    timestampMs:
      timestampMs === undefined
        ? Date.now()
        : typeof timestampMs === 'bigint'
          ? Number(timestampMs)
          : timestampMs,
  };
}

export function clientCommandAck(
  commandId: string,
  status: 'ok' | 'rejected' | 'failed' = 'ok',
  message?: string,
): ClientMsg {
  const statusMap = {
    ok: CommandAckStatus.OK,
    rejected: CommandAckStatus.REJECTED,
    failed: CommandAckStatus.FAILED,
  } as const;
  return {
    type: 'commandAck',
    commandId,
    status: statusMap[status],
    message: message ?? '',
  };
}

export function messageBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  throw new Error('expected binary WebSocket frame');
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
