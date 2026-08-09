/** Hard cap for live `publish` / `publishBatch` (points per second). */
export const MAX_PUBLISH_HZ = 50;

/** Minimum gap between accepted points implied by {@link MAX_PUBLISH_HZ}. */
export const MIN_PUBLISH_INTERVAL_MS = Math.ceil(1000 / MAX_PUBLISH_HZ);

/** Opaque custom events (ephemeral fan-out). */
export const MAX_EVENT_HZ = 1;
export const MIN_EVENT_INTERVAL_MS = Math.ceil(1000 / MAX_EVENT_HZ);
export const MAX_EVENT_BYTES = 4 * 1024;

/** Whether `pointCount` points can be accepted at `now` under the 50 Hz gate. */
export function canAcceptPublish(
  nextAllowedAt: number,
  now: number,
  pointCount: number,
): boolean {
  if (pointCount <= 0) {
    return true;
  }
  return now >= nextAllowedAt;
}

/** Advance the gate after accepting `pointCount` points at `now`. */
export function nextPublishAllowedAt(
  nextAllowedAt: number,
  now: number,
  pointCount: number,
): number {
  const start = Math.max(now, nextAllowedAt);
  return start + MIN_PUBLISH_INTERVAL_MS * Math.max(pointCount, 0);
}
