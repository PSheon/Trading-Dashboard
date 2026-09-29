import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

/**
 * Polling side of the pipeline (§4.2 W4): clearinghouseState every 5 min
 * per address → position_snapshots + equity_snapshots, plus reconciliation
 * against `fills` when a position change has no matching fill.
 *
 * The cron job below is intentionally a no-op for M1 so an early `nest
 * start` doesn't throw on a timer every 5 minutes — the per-address poll
 * logic is the next task's scope, not this scaffold's.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollAllLeaders(): Promise<void> {
    // TODO: for each active leader, call pollLeader(address); this is where
    // W6's request-weight budgeter also needs to pace the 100 x
    // clearinghouseState calls per cycle.
    this.logger.debug("pollAllLeaders tick — not implemented yet");
  }

  /** Polls one address: writes a position + equity snapshot, reconciles. */
  async pollLeader(_address: string): Promise<void> {
    throw new Error("not implemented");
  }

  /** Refreshes coin_meta from `meta()` (szDecimals, max leverage). */
  async refreshCoinMeta(): Promise<void> {
    throw new Error("not implemented");
  }

  /** N3: records mid price 1h/4h/24h after a sent alert. */
  async scoreAlert(_alertId: bigint): Promise<void> {
    throw new Error("not implemented");
  }
}
