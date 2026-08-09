/**
 * Async semaphore for a constant-concurrency conveyor: at most `limit` tasks
 * run at once; when one finishes, the next waiter starts immediately
 * (not “finish a wave of N, then start the next wave”).
 */
export function createPool(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      next();
    }
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return { run, acquire, release };
}
