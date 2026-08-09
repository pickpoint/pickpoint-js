import { describe, expect, it } from 'vitest';
import {
  MAX_PUBLISH_HZ,
  MIN_PUBLISH_INTERVAL_MS,
  canAcceptPublish,
  nextPublishAllowedAt,
} from '../src/tracking/rate.js';

describe('publish rate limit', () => {
  it('allows 50 Hz spacing', () => {
    expect(MAX_PUBLISH_HZ).toBe(50);
    expect(MIN_PUBLISH_INTERVAL_MS).toBe(20);
    expect(canAcceptPublish(0, 0, 1)).toBe(true);
    const next = nextPublishAllowedAt(0, 0, 1);
    expect(next).toBe(20);
    expect(canAcceptPublish(next, 19, 1)).toBe(false);
    expect(canAcceptPublish(next, 20, 1)).toBe(true);
  });

  it('batches consume N slots', () => {
    const next = nextPublishAllowedAt(0, 1000, 50);
    expect(next).toBe(2000);
    expect(canAcceptPublish(next, 1999, 1)).toBe(false);
    expect(canAcceptPublish(next, 2000, 1)).toBe(true);
  });
});
