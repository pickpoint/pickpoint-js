import type { ReconnectOptions } from './types';

export type BackoffState = {
  attempt: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
};

export function createBackoff(opts?: ReconnectOptions): BackoffState {
  return {
    attempt: 0,
    minDelayMs: opts?.minDelayMs ?? 500,
    maxDelayMs: opts?.maxDelayMs ?? 30_000,
    maxAttempts: opts?.maxAttempts ?? Number.POSITIVE_INFINITY,
  };
}

/** Full-jitter exponential backoff: random in [0, min(max, min * 2^attempt)]. */
export function nextDelayMs(state: BackoffState, random = Math.random): number | null {
  if (state.attempt >= state.maxAttempts) {
    return null;
  }
  const exp = Math.min(
    state.maxDelayMs,
    state.minDelayMs * 2 ** state.attempt,
  );
  state.attempt += 1;
  return Math.floor(random() * exp);
}

export function resetBackoff(state: BackoffState): void {
  state.attempt = 0;
}
