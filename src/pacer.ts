export class WaitPacer {
  private maxPerInterval: number;
  private intervalMs: number;
  private minGapMs: number;

  // track start times within the sliding window
  private starts: number[] = [];
  private lastStart = 0;

  // serialize callers so their start times are paced correctly
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: { maxPerInterval: number; intervalMs: number }) {
    this.maxPerInterval = Math.max(1, opts.maxPerInterval);
    this.intervalMs = Math.max(1, opts.intervalMs);
    // even spacing target
    this.minGapMs = Math.floor(this.intervalMs / this.maxPerInterval);
  }

  setRate(maxPerInterval: number, intervalMs: number) {
    this.maxPerInterval = Math.max(1, maxPerInterval);
    this.intervalMs = Math.max(1, intervalMs);
    this.minGapMs = Math.floor(this.intervalMs / this.maxPerInterval);
  }

  private now() {
    return Date.now();
  }
  private sleep(ms: number) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private pruneWindow(now: number) {
    const cutoff = now - this.intervalMs;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
  }

  /** Await this immediately before the call that could rate-limit */
  waitForPacer(): Promise<void> {
    // Chain to tail so concurrent callers are paced, not released together
    const ticket = this.tail.then(async () => {
      // figure out when we're allowed to start
      while (true) {
        const now = this.now();
        this.pruneWindow(now);

        // if we've already hit the sliding-window cap, wait until the oldest exits
        if (this.starts.length >= this.maxPerInterval) {
          const earliest = this.starts[0];
          const waitUntil = earliest + this.intervalMs;
          await this.sleep(Math.max(0, waitUntil - this.now()));
          continue; // recheck constraints after waiting
        }

        // enforce even spacing between starts
        const earliestStart = this.lastStart + this.minGapMs;
        const delay = Math.max(0, earliestStart - now);
        if (delay > 0) {
          await this.sleep(delay);
          continue; // recheck after sleeping
        }

        // We can start now
        const startTs = this.now();
        this.lastStart = startTs;
        this.starts.push(startTs);
        break;
      }
    });

    // advance the tail to this ticket (so the next caller queues behind it)
    this.tail = ticket.catch(() => {}); // don't block the chain on errors
    return ticket;
  }
}
