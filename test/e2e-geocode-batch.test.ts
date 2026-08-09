import { describe, expect, it } from 'vitest';
import { PickPoint } from '@pickpoint/sdk';

const apiKey = process.env.PICKPOINT_API_KEY;
const baseUrl = process.env.PICKPOINT_BASE_URL;
const BATCH = 100;

type TimedFetch = {
  fetch: typeof globalThis.fetch;
  samplesMs: () => number[];
};

function timedFetch(): TimedFetch {
  const base = globalThis.fetch.bind(globalThis);
  const samples: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const t0 = performance.now();
    try {
      return await base(input, init);
    } finally {
      samples.push(performance.now() - t0);
    }
  };
  return { fetch, samplesMs: () => samples.slice() };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  const rank = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length - 1)]!;
}

function reportLatency(label: string, wallMs: number, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const msg =
    `${label} batch n=${sorted.length} wall=${wallMs.toFixed(0)}ms | ` +
    `per-request ms: min=${sorted[0]!.toFixed(1)} ` +
    `p50=${percentile(sorted, 50).toFixed(1)} ` +
    `p90=${percentile(sorted, 90).toFixed(1)} ` +
    `p95=${percentile(sorted, 95).toFixed(1)} ` +
    `p99=${percentile(sorted, 99).toFixed(1)} ` +
    `max=${sorted[sorted.length - 1]!.toFixed(1)} ` +
    `mean=${mean.toFixed(1)}`;
  // eslint-disable-next-line no-console
  console.log(msg);
}

function liveClient(fetch: typeof globalThis.fetch): PickPoint {
  return new PickPoint({
    apiKey: apiKey!,
    baseUrl,
    timeoutMs: 60_000,
    fetch,
  });
}

describe.skipIf(!apiKey)('e2e geocode batch (live API)', () => {
  it(
    'forward batch: 100 identical queries',
    async () => {
      const timed = timedFetch();
      const pp = liveClient(timed.fetch);
      const inputs = Array.from({ length: BATCH }, () => ({
        q: 'Berlin',
        limit: 1,
      }));
      const t0 = performance.now();
      const out = await pp.forward(inputs);
      const wallMs = performance.now() - t0;
      expect(out).toHaveLength(BATCH);
      for (const [i, slot] of out.entries()) {
        expect(slot.length, `slot ${i}`).toBeGreaterThan(0);
      }
      const samples = timed.samplesMs();
      expect(samples.length).toBeGreaterThanOrEqual(BATCH);
      reportLatency('forward', wallMs, samples);
      pp.close();
    },
    120_000,
  );

  it(
    'reverse batch: 100 identical queries',
    async () => {
      const timed = timedFetch();
      const pp = liveClient(timed.fetch);
      // Brandenburg Gate
      const inputs = Array.from({ length: BATCH }, () => ({
        lat: 52.5163,
        lon: 13.3777,
      }));
      const t0 = performance.now();
      const out = await pp.reverse(inputs);
      const wallMs = performance.now() - t0;
      expect(out).toHaveLength(BATCH);
      for (const [i, slot] of out.entries()) {
        expect(slot, `slot ${i}`).not.toBeNull();
      }
      const samples = timed.samplesMs();
      expect(samples.length).toBeGreaterThanOrEqual(BATCH);
      reportLatency('reverse', wallMs, samples);
      pp.close();
    },
    120_000,
  );
});
