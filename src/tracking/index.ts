/**
 * Tracking client (WebSocket + tracking.v2 protobuf).
 * Full wire codec + resume land next; this stub defines the public shape.
 */

export type DeviceAuth = {
  clientId: string;
  clientSecret: string;
};

export type ListenerAuth = {
  accessToken: string;
};

export type TrackingConfig = {
  /** e.g. wss://tracking.example.com */
  endpoint: string;
  auth: DeviceAuth | ListenerAuth;
};

export type TrackingClient = {
  close(): void;
  /** Device: start a track (implemented when server edge-ws is ready). */
  startTrack(): Promise<string>;
};

/**
 * Open a tracking session over WebSocket (`/v2/tracking/ws`).
 * @throws until binary protobuf transport is wired
 */
export function connect(_config: TrackingConfig): Promise<TrackingClient> {
  return Promise.reject(
    new Error(
      '@pickpoint/sdk/tracking: connect() not implemented yet — awaiting tracking.v2 WS edge',
    ),
  );
}
