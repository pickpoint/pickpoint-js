/**
 * Tracking client — binary WebSocket `tracking.v2`.
 * Works in browsers (global WebSocket) and Node (`ws`).
 */

export { createBackoff, nextDelayMs, resetBackoff } from './backoff';
export type { BackoffState } from './backoff';
export { connect } from './client';
export {
  PROTOCOL_VERSION,
  bytesToHex,
  clientCommandAck,
  clientEvent,
  clientLoc,
  clientLocationAdd,
  clientLocationBatch,
  clientResume,
  clientSubscribe,
  clientTrackStart,
  clientTrackStop,
  clientUnsubscribe,
  decodeClientMsg,
  decodeServerMsg,
  degToMicro,
  encodeClientMsg,
  encodeLocFrames,
  encodeServerMsg,
  hexToBytes,
  microDeltaFits,
  microToDeg,
  toLatLng,
  toLiveLatLng,
} from './codec';
export { TrackingSdkError, isFatalResumeError } from './errors';
export { NoiseFilter, haversineMeters } from './filter';
export { OfflineQueue, TrackBuffers } from './queue';
export {
  MAX_EVENT_BYTES,
  MAX_EVENT_HZ,
  MAX_PUBLISH_HZ,
  MIN_EVENT_INTERVAL_MS,
  MIN_PUBLISH_INTERVAL_MS,
  canAcceptPublish,
  nextPublishAllowedAt,
} from './rate';
export {
  DEFAULT_TRACKING_PATH,
  TRACKING_SUBPROTOCOL,
  buildWsUrl,
} from './url';
export { CommandAckStatus, ErrorCode } from './types';

export type {
  Auth,
  ClientMsg,
  Command,
  ConnectionState,
  DeviceAuth,
  DevicePresence,
  EventAdded,
  LatLng,
  LatLngInput,
  ListenerAuth,
  LocationAdded,
  ReconnectOptions,
  RelocateInfo,
  ServerMsg,
  StartTrackOptions,
  SubscribeOptions,
  Subscribed,
  TrackingClient,
  TrackingConfig,
  TrackingError,
  TrackingEvents,
  WebSocketConstructor,
  WebSocketLike,
} from './types';
