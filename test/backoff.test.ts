import { describe, expect, it } from 'vitest';
import { createBackoff, nextDelayMs, resetBackoff } from '@pickpoint/sdk/tracking';

describe('backoff', () => {
  it('uses full jitter within [0, cap]', () => {
    const state = createBackoff({ minDelayMs: 100, maxDelayMs: 800 });
    const delays: number[] = [];
    let i = 0;
    const random = () => {
      const values = [0, 0.5, 0.999];
      return values[i++ % values.length]!;
    };
    for (let n = 0; n < 3; n++) {
      const d = nextDelayMs(state, random);
      expect(d).not.toBeNull();
      delays.push(d!);
    }
    expect(delays[0]).toBe(0); // 0 * 100
    expect(delays[1]).toBe(100); // 0.5 * 200
    expect(delays[2]).toBe(399); // floor(0.999 * 400)
  });

  it('respects maxAttempts', () => {
    const state = createBackoff({ minDelayMs: 10, maxAttempts: 2 });
    expect(nextDelayMs(state, () => 0)).toBe(0);
    expect(nextDelayMs(state, () => 0)).toBe(0);
    expect(nextDelayMs(state, () => 0)).toBeNull();
  });

  it('reset clears attempt counter', () => {
    const state = createBackoff({ minDelayMs: 10, maxAttempts: 1 });
    expect(nextDelayMs(state, () => 0)).toBe(0);
    expect(nextDelayMs(state, () => 0)).toBeNull();
    resetBackoff(state);
    expect(nextDelayMs(state, () => 0)).toBe(0);
  });
});
