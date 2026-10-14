export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Sequential politeness: each wait() returns at least `intervalMs` after the
 * previous one returned. The first call doesn't wait.
 */
export function createRateLimiter(intervalMs: number, clock: Clock = realClock) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    intervalMs,
    async wait(): Promise<void> {
      const delay = last + intervalMs - clock.now();
      if (delay > 0) await clock.sleep(delay);
      last = clock.now();
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
