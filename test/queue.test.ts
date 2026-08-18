import { describe, expect, it, vi } from 'vitest';
import { OfflineQueue, TrackBuffers } from '@pickpoint/sdk/tracking';

describe('OfflineQueue / TrackBuffers', () => {
  it('acks through seq inclusively', () => {
    const q = new OfflineQueue(10);
    q.enqueue(1n, { latitude: 1, longitude: 1 });
    q.enqueue(2n, { latitude: 2, longitude: 2 });
    q.enqueue(3n, { latitude: 3, longitude: 3 });
    q.ackThrough(2n);
    expect(q.peekAll().map((p) => p.seq)).toEqual([3n]);
  });

  it('overflow keeps newest and reports gap', () => {
    const onGap = vi.fn();
    const q = new OfflineQueue(2, onGap);
    q.enqueue(1n, { latitude: 1, longitude: 1 });
    q.enqueue(2n, { latitude: 2, longitude: 2 });
    q.enqueue(3n, { latitude: 3, longitude: 3 });
    expect(onGap).toHaveBeenCalledWith(1);
    expect(q.peekAll().map((p) => p.seq)).toEqual([2n, 3n]);
  });

  it('stages without seq; ackThrough only drops InFlight', () => {
    const b = new TrackBuffers(10);
    b.stage({ latitude: 1, longitude: 1 });
    b.addInFlight(1, { latitude: 2, longitude: 2 });
    b.ackThrough(1);
    expect(b.stagingSize).toBe(1);
    expect(b.inFlightSize).toBe(0);
  });
});
