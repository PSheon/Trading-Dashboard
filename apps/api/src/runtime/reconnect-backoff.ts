/**
 * When a LISTEN connection that keeps failing tries again: 1 s, 2 s, 4 s …
 * up to 30 s, back to 1 s once it connects. `transition` is true for the
 * first failure after a good connection only, so a database that is down
 * for a minute logs one warning (and one line when it is back), not one
 * every second.
 */
export class ReconnectBackoff {
  private failures = 0;
  constructor(private readonly baseMs = 1000, private readonly maxMs = 30_000) {}
  /** A failure: how long to wait, and whether it is the first in a row. */
  failed(): { delayMs: number; transition: boolean } {
    const delayMs = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.failures, 16));
    this.failures += 1;
    return { delayMs, transition: this.failures === 1 };
  }
  /** Connected: whether this ends a run of failures. */
  connected(): boolean {
    const recovered = this.failures > 0;
    this.failures = 0;
    return recovered;
  }
}
