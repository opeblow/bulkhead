/**
 * Client-side pacing to stay under the sandbox limits (20 rps global, 10 rps per endpoint,
 * 10 concurrent). We aim lower so a demo never trips a 429.
 */
export class RateLimiter {
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];
  private readonly global: number[] = [];
  private readonly perPath = new Map<string, number[]>();

  constructor(
    private readonly opts = { globalRps: 15, perPathRps: 8, concurrency: 6 },
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async run<T>(path: string, fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.waitForWindow(path);
      return await fn();
    } finally {
      this.inFlight--;
      this.queue.shift()?.();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.opts.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.queue.push(() => {
        this.inFlight++;
        resolve();
      }),
    );
  }

  private async waitForWindow(path: string): Promise<void> {
    const key = path.replace(/\/[a-z]+_[A-Za-z0-9-]+/g, "/:id");
    for (;;) {
      const t = this.now();
      prune(this.global, t);
      const bucket = this.perPath.get(key) ?? [];
      prune(bucket, t);
      if (this.global.length < this.opts.globalRps && bucket.length < this.opts.perPathRps) {
        this.global.push(t);
        bucket.push(t);
        this.perPath.set(key, bucket);
        return;
      }
      const oldest = Math.min(this.global[0] ?? t, bucket[0] ?? t);
      await this.sleep(Math.max(5, 1000 - (t - oldest)));
    }
  }
}

function prune(arr: number[], t: number): void {
  while (arr.length && t - arr[0]! >= 1000) arr.shift();
}
