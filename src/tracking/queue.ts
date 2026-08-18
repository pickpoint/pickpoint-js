import { perpendicularDistanceM } from './filter';
import type { LatLngInput } from './types';

export type InFlightPoint = {
  seq: number;
  point: LatLngInput;
};

/**
 * Staging (no seq) + InFlight (seq assigned, waiting for Ack).
 * Combined cap 10_000; overflow collapses collinear middle samples, keeps newest.
 */
export class TrackBuffers {
  private staging: LatLngInput[] = [];
  private inFlight: InFlightPoint[] = [];

  constructor(
    readonly maxSize: number,
    private readonly onGap?: (dropped: number) => void,
  ) {}

  get size(): number {
    return this.staging.length + this.inFlight.length;
  }

  get stagingSize(): number {
    return this.staging.length;
  }

  get inFlightSize(): number {
    return this.inFlight.length;
  }

  stage(point: LatLngInput): void {
    this.staging.push(point);
    this.enforceCap();
  }

  addInFlight(seq: number, point: LatLngInput): void {
    this.inFlight.push({ seq, point });
    this.enforceCap();
  }

  /** Drop InFlight entries with seq <= ack (inclusive). */
  ackThrough(ack: number): void {
    this.inFlight = this.inFlight.filter((p) => p.seq > ack);
  }

  peekStaging(): readonly LatLngInput[] {
    return this.staging;
  }

  peekInFlight(): readonly InFlightPoint[] {
    return this.inFlight;
  }

  /** Remove the first `n` staging points (caller assigns seq). */
  takeStaging(n: number): LatLngInput[] {
    return this.staging.splice(0, Math.max(0, n));
  }

  clear(): void {
    this.staging = [];
    this.inFlight = [];
  }

  private enforceCap(): void {
    if (this.size <= this.maxSize) {
      return;
    }
    let dropped = 0;
    while (this.size > this.maxSize) {
      const mid = this.findCollinearMiddle();
      if (mid >= 0) {
        this.staging.splice(mid, 1);
        dropped += 1;
        continue;
      }
      if (this.staging.length > 0) {
        this.staging.shift();
        dropped += 1;
        continue;
      }
      if (this.inFlight.length > 0) {
        this.inFlight.shift();
        dropped += 1;
        continue;
      }
      break;
    }
    if (dropped > 0) {
      this.onGap?.(dropped);
    }
  }

  private findCollinearMiddle(): number {
    for (let i = 1; i < this.staging.length - 1; i++) {
      const cur = this.staging[i]!;
      const ε = Math.max(2, cur.accuracy ?? 0);
      if (
        perpendicularDistanceM(this.staging[i - 1]!, this.staging[i + 1]!, cur) < ε
      ) {
        return i;
      }
    }
    return -1;
  }
}

/** @deprecated Use {@link TrackBuffers}. Kept for tests that enqueue sequenced points. */
export class OfflineQueue {
  private readonly inner: TrackBuffers;

  constructor(maxSize: number, onGap?: (dropped: number) => void) {
    this.inner = new TrackBuffers(maxSize, onGap);
  }

  get size(): number {
    return this.inner.size;
  }

  enqueue(seq: bigint, point: LatLngInput): void {
    this.inner.addInFlight(Number(seq), point);
  }

  ackThrough(ack: bigint): void {
    this.inner.ackThrough(Number(ack));
  }

  peekAll(): readonly { seq: bigint; point: LatLngInput }[] {
    return this.inner.peekInFlight().map((p) => ({
      seq: BigInt(p.seq),
      point: p.point,
    }));
  }

  clear(): void {
    this.inner.clear();
  }
}
