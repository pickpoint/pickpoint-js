import type { LatLngInput } from './types';

const EARTH_M = 6_371_000;
const HEARTBEAT_MS = 1000;
const MIN_MOVE_M = 2;
const HEADING_JUMP_DEG = 25;
const MOTION_MPS = 0.5;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(
  a: Pick<LatLngInput, 'latitude' | 'longitude'>,
  b: Pick<LatLngInput, 'latitude' | 'longitude'>,
): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δφ = toRad(b.latitude - a.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toXY(
  origin: Pick<LatLngInput, 'latitude' | 'longitude'>,
  p: Pick<LatLngInput, 'latitude' | 'longitude'>,
): [number, number] {
  const x =
    (p.longitude - origin.longitude) *
    Math.cos(toRad(origin.latitude)) *
    111_320;
  const y = (p.latitude - origin.latitude) * 110_540;
  return [x, y];
}

/** Perpendicular distance from `c` to the line `a → b`, metres. */
export function perpendicularDistanceM(
  a: Pick<LatLngInput, 'latitude' | 'longitude'>,
  b: Pick<LatLngInput, 'latitude' | 'longitude'>,
  c: Pick<LatLngInput, 'latitude' | 'longitude'>,
): number {
  const [bx, by] = toXY(a, b);
  const [cx, cy] = toXY(a, c);
  const len = Math.hypot(bx, by);
  if (len < 1e-6) {
    return Math.hypot(cx, cy);
  }
  return Math.abs(bx * cy - by * cx) / len;
}

export function headingDeltaDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) {
    d = 360 - d;
  }
  return d;
}

/**
 * Device GPS filter (filter.md). Runs before Staging / seq / Loc.
 * Heading and speed stay local; they are not written to the frame.
 */
export class NoiseFilter {
  private lastEmitted: LatLngInput | null = null;
  private candidate: LatLngInput | null = null;
  private lastEmitAt = 0;
  private lastSpeed = 0;

  reset(): void {
    this.lastEmitted = null;
    this.candidate = null;
    this.lastEmitAt = 0;
    this.lastSpeed = 0;
  }

  /**
   * Feed one GPS sample. Returns the point to Staging/send, or null if held.
   */
  push(sample: LatLngInput, now = Date.now()): LatLngInput | null {
    const accuracy = sample.accuracy ?? 0;
    const speed = sample.speed ?? 0;

    if (!this.lastEmitted) {
      return this.emit(sample, now);
    }

    if (now - this.lastEmitAt >= HEARTBEAT_MS) {
      return this.emit(sample, now);
    }

    const moved = haversineMeters(this.lastEmitted, sample);
    if (moved >= Math.max(MIN_MOVE_M, 2 * accuracy)) {
      return this.emit(sample, now);
    }

    if (
      sample.heading !== undefined &&
      this.lastEmitted.heading !== undefined &&
      headingDeltaDeg(sample.heading, this.lastEmitted.heading) >= HEADING_JUMP_DEG
    ) {
      return this.emit(sample, now);
    }

    if (sample.speed !== undefined || this.lastEmitted.speed !== undefined) {
      const moving = speed >= MOTION_MPS;
      const wasMoving = this.lastSpeed >= MOTION_MPS;
      if (moving !== wasMoving) {
        return this.emit(sample, now);
      }
    }

    if (this.candidate) {
      const ε = Math.max(MIN_MOVE_M, accuracy, 0.5 * speed);
      const perp = perpendicularDistanceM(this.lastEmitted, sample, this.candidate);
      if (perp >= ε) {
        return this.emit(this.candidate, now);
      }
    }

    this.candidate = sample;
    this.lastSpeed = speed;
    return null;
  }

  private emit(point: LatLngInput, now: number): LatLngInput {
    this.lastEmitted = point;
    this.candidate = null;
    this.lastEmitAt = now;
    this.lastSpeed = point.speed ?? 0;
    return point;
  }
}
