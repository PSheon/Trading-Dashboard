import { Inject, Injectable, Logger } from "@nestjs/common";
import { fills } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { isOutOfScopeSpotFill } from "./action-classifier.js";
import { toFillRow } from "./fill-row.js";

export type BackfillStatus =
  | { status: "running"; startedAt: Date }
  | { status: "done"; startedAt: Date; completedAt: Date; fillsFetched: number }
  | { status: "failed"; startedAt: Date; completedAt: Date; error: string };

/** Hyperliquid returns at most 2000 fills per call and only retains a
 * user's most recent 10,000 fills — 10 pages is 20,000, double the
 * documented ceiling, as a safety margin against an off-by-one in the
 * pagination cursor rather than an expectation of actually using it all. */
const MAX_BACKFILL_PAGES = 10;
const PAGE_SIZE_HINT = 2000;

/**
 * A5: one-shot historical backfill for a newly-added leader, paginating
 * `userFillsByTime` from the earliest reachable point up to now.
 *
 * Fired-and-tracked (not a job queue — §11 "最小基礎設施", no Redis): A2
 * calls `trigger()` right after upserting a new `leaders` row and does not
 * await it, so the import HTTP response isn't held up by however long a
 * 100k-fill-history whale takes to backfill. Completion/failure is kept in
 * an in-process status map, inspectable via `getStatus`/`getAll` (surfaced
 * on `/health` — see `health.service.ts`).
 *
 * Pagination direction: confirmed live (2026-09-29) that `userFillsByTime`
 * returns fills in ascending time order, so pagination walks *forward*
 * from `startTime`, advancing to `lastFill.time + 1` after each page —
 * not backward from `endTime`, which is what "the oldest fill timestamp
 * seen in each page" would suggest for a descending-order API. A page
 * shorter than the 2000-row cap means there is nothing newer left to fetch
 * (we've caught up to "now" within Hyperliquid's retained window).
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly statuses = new Map<string, BackfillStatus>();

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
  ) {}

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

  /** Does the actual paginated fetch + insert. Exposed (not just via
   * `trigger`) so tests can `await` it directly instead of racing a
   * fire-and-forget promise. */
  async run(address: string): Promise<number> {
    let startTime = 0;
    let totalFetched = 0;

    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
      const rawFills = await this.info.userFillsByTime(address, startTime);
      if (rawFills.length === 0) break;

      totalFetched += rawFills.length;
      const perpsFills = rawFills.filter((f) => !isOutOfScopeSpotFill(f));
      if (perpsFills.length > 0) {
        const rows = perpsFills.map((f) => toFillRow(address, f));
        await this.db.insert(fills).values(rows).onConflictDoNothing();
      }

      if (rawFills.length < PAGE_SIZE_HINT) break; // caught up to "now"

      const last = rawFills[rawFills.length - 1];
      startTime = last.time + 1;
    }

    return totalFetched;
  }

  getStatus(address: string): BackfillStatus | undefined {
    return this.statuses.get(address);
  }

  getAllStatuses(): ReadonlyMap<string, BackfillStatus> {
    return this.statuses;
  }
}
