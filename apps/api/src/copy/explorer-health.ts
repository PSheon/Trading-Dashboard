/**
 * Whether this process reaches Hyperliquid's explorer (txDetails, the
 * proof a deposit is the transfer its owner signed), as a gauge for the
 * heartbeat: since when its reads have failed for the network (DNS,
 * connect, timeout) without one answering in between. Each deposit keeps
 * its own durable record too (scan_state.explorerFailingSince).
 */
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
