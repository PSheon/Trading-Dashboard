import { Injectable, Logger } from "@nestjs/common";

import { FillSyncService } from "./fill-sync.service.js";

export type BackfillStatus =
  | { status: "running"; startedAt: Date }
  | { status: "done"; startedAt: Date; completedAt: Date; fillsFetched: number }
  | { status: "failed"; startedAt: Date; completedAt: Date; error: string };

/**
 * A5: one-shot history backfill for a newly added leader — every fill
 * Hyperliquid still has for it (the latest 10,000), through the same
 * `FillSyncService` path as live fills, in the background priority lane so
 * importing a list never delays live detection.
 *
 * History also becomes `actions` (win rate and PnL need round trips), but no
 * `action.created` event is emitted for it: rules only see live actions.
 *
 * Fire-and-track (not a job queue — §11 "最小基礎設施", no Redis): A2 calls
 * `trigger()` and doesn't wait. Status is kept in memory and shown on
 * `/health`.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly statuses = new Map<string, BackfillStatus>();

  constructor(private readonly fillSync: FillSyncService) {}

  /** Fire-and-forget entry point — does not block the caller. */
  trigger(address: string): void {
    const startedAt = new Date();
    this.statuses.set(address, { status: "running", startedAt });
    void this.run(address)
      .then((fillsFetched) => {
        this.statuses.set(address, {
          status: "done",
          startedAt,
          completedAt: new Date(),
          fillsFetched,
        });
        this.logger.log(`Backfill complete for ${address}: ${fillsFetched} fills fetched`);
      })
      .catch((error: unknown) => {
        this.statuses.set(address, {
          status: "failed",
          startedAt,
          completedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.error(
          `Backfill failed for ${address}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** Runs the backfill and resolves with the number of fills fetched.
   * Exposed so tests can await it. */
  async run(address: string): Promise<number> {
    const result = await this.fillSync.sync(address, "backfill", 0);
    return result.fetched;
  }

  getStatus(address: string): BackfillStatus | undefined {
    return this.statuses.get(address);
  }

  getAllStatuses(): ReadonlyMap<string, BackfillStatus> {
    return this.statuses;
  }
}
