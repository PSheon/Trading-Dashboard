import { sleep } from "./http";

/**
 * Spaces requests to one endpoint group; concurrent callers queue in order.
 * Adaptive: a 429 doubles the spacing (up to MAX_INTERVAL_MS) and every
 * success eases it back toward the plan's rate, so a limit we did not know
 * about slows us down instead of failing the wallet.
 */
export class Throttle {
  private gate: Promise<void> = Promise.resolve();
  private last = 0;
  private interval: number;

  constructor(private readonly baseMs: number) {
    this.interval = baseMs;
  }

  wait(extraMs = 0): Promise<void> {
    const turn = this.gate.then(async () => {
      const wait = Math.max(this.interval - (Date.now() - this.last), extraMs);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.gate = turn;
    return turn;
  }

  slowDown(): void {
    this.interval = Math.min(this.interval * 2, MAX_INTERVAL_MS);
  }

  recover(): void {
    this.interval = Math.max(this.baseMs, Math.floor(this.interval * 0.9));
  }
}


const MAX_INTERVAL_MS = 5_000;
