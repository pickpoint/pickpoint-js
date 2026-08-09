/**
 * Tracking client — binary WebSocket + `tracking.v2` protobuf.
 * Works in browsers (global WebSocket) and Node (`ws`).
 */

export { connect } from './client.js';
export { TrackingSdkError, isFatalResumeError } from './errors.js';
export {
  MAX_EVENT_BYTES,
  MAX_EVENT_HZ,
  MAX_PUBLISH_HZ,
  MIN_EVENT_INTERVAL_MS,
  MIN_PUBLISH_INTERVAL_MS,
} from './rate.js';
export { TRACKING_SUBPROTOCOL, buildWsUrl } from './url.js';
export { ErrorCode } from '../gen/tracking/v2/messages_pb.js';

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
} from './types.js';
