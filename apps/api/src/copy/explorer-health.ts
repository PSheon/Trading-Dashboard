/** Heartbeat gauge: since when this process's explorer reads (txDetails) have failed with none
 * answering in between. Deposits also keep scan_state.explorerFailingSince. */
class ExplorerHealth {
  private failingSince: number | null = null;
  /** A read answered. */
  reachable(): void { this.failingSince = null; }
  /** A read could not reach the explorer at `at`; the first such since the last answer starts the outage. */
  unreachable(at: number = Date.now()): void { this.failingSince ??= at; }
  status(): { reachable: boolean; failingSince: Date | null } {
    return { reachable: this.failingSince === null, failingSince: this.failingSince === null ? null : new Date(this.failingSince) };
  }
}

/** The process's gauge (the worker's heartbeat reports it). */
export const explorerHealth = new ExplorerHealth();
