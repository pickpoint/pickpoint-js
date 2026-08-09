import type { LatLngInput } from './types';

export type QueuedPoint = {
  seq: bigint;
  point: LatLngInput;
};

/**
 * Bounded offline queue keyed by clientSeq.
 * Drop-oldest on overflow; caller is notified via onGap.
 */
export class OfflineQueue {
  private items: QueuedPoint[] = [];

  constructor(
    readonly maxSize: number,
    private readonly onGap?: (dropped: number) => void,
  ) {}

  get size(): number {
    return this.items.length;
  }

  enqueue(seq: bigint, point: LatLngInput): void {
    this.items.push({ seq, point });
    if (this.items.length > this.maxSize) {
      const dropped = this.items.length - this.maxSize;
      this.items.splice(0, dropped);
      this.onGap?.(dropped);
    }
  }

  /** Drop points with seq <= ack (inclusive). */
  ackThrough(ack: bigint): void {
    this.items = this.items.filter((p) => p.seq > ack);
  }

  peekAll(): readonly QueuedPoint[] {
    return this.items;
  }

  clear(): void {
    this.items = [];
  }
}
