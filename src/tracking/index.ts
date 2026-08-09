/**
 * Tracking client — binary WebSocket + `tracking.v2` protobuf.
 * Works in browsers (global WebSocket) and Node (`ws`).
 */

export { createBackoff, nextDelayMs, resetBackoff } from './backoff';
export type { BackoffState } from './backoff';
export { connect } from './client';
export {
  clientEvent,
  clientLocationAdd,
  clientLocationBatch,
  clientPing,
  clientResume,
  clientSubscribe,
  clientTrackStart,
  clientTrackStop,
  decodeServerMsg,
  encodeClientMsg,
  encodeServerMsg,
  toLatLng,
} from './codec';
export { TrackingSdkError, isFatalResumeError } from './errors';
export { OfflineQueue } from './queue';
export {
  MAX_EVENT_BYTES,
  MAX_EVENT_HZ,
  MAX_PUBLISH_HZ,
  MIN_EVENT_INTERVAL_MS,
  MIN_PUBLISH_INTERVAL_MS,
  canAcceptPublish,
  nextPublishAllowedAt,
} from './rate';
export { TRACKING_SUBPROTOCOL, buildWsUrl } from './url';
export {
  ClientMsgSchema,
  ErrorCode,
  ServerMsgSchema,
} from '../gen/tracking/v2/messages_pb';
export type { ClientMsg, ServerMsg } from '../gen/tracking/v2/messages_pb';

export type {
  Auth,
  ConnectionState,
  Command,
  DeviceAuth,
  DevicePresence,
  EventAdded,
  LatLng,
  LatLngInput,
  ListenerAuth,
  LocationAdded,
  ReconnectOptions,
  RelocateInfo,
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
