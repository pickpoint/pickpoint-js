import { describe, expect, it } from 'vitest';
import { NoiseFilter } from '@pickpoint/sdk/tracking';

describe('NoiseFilter', () => {
  it('emits the first point of a track', () => {
    const f = new NoiseFilter();
    const p = f.push({ latitude: 55, longitude: 37 }, 1_000);
    expect(p).toEqual({ latitude: 55, longitude: 37 });
  });

  it('holds collinear junk between heartbeats', () => {
    const f = new NoiseFilter();
    const t0 = 10_000;
    expect(f.push({ latitude: 55, longitude: 37, accuracy: 1 }, t0)).toBeTruthy();
    // ~0.5 m north — below 2 m floor, same heading, no heartbeat yet
    const held = f.push(
      { latitude: 55.000004, longitude: 37, accuracy: 1 },
      t0 + 20,
    );
    expect(held).toBeNull();
  });

  it('heartbeat emits the current position after 1 s', () => {
    const f = new NoiseFilter();
    const t0 = 10_000;
    f.push({ latitude: 55, longitude: 37 }, t0);
    const later = f.push({ latitude: 55.000001, longitude: 37 }, t0 + 1000);
    expect(later).toBeTruthy();
    expect(later!.latitude).toBeCloseTo(55.000001);
  });
});
