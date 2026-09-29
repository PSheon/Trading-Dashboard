import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { CHAIN_DEFAULT, actions, fills } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

type ActionRow = typeof actions.$inferSelect;

/** One reconstructed "open to flat" position, per §11 決策紀錄 "勝率與 PnL 單位":
 * "以一次完整倉位（開到平）為一筆；直接加總平倉 fill 的 closed_pnl". */
export interface RoundTrip {
  address: string;
  coin: string;
  /** Side of the leg that closed (a flip's closing leg is the side it came
   * *from*, not the new side it opened into). */
  side: string;
  openTs: Date;
  closeTs: Date;
  /** Sum of `closed_pnl` across the closing/flip action's fills. */
  pnl: number;
  holdTimeSeconds: number;
}

/**
 * Reconstructs realized round trips from `actions` + `fills` and derives
 * win rate / realized PnL / average hold time from them (§2 of the M2 task,
 * §11 "勝率與 PnL 單位"). Hyperliquid already computes `closed_pnl` per
 * fill — this service never re-derives PnL from entry/exit prices itself,
 * it only sums the field Hyperliquid already gives us.
 *
 * A round trip runs from an `open` action to the next `close` **or `flip`**
 * action for that (address, coin) — a flip is terminal for the side that
 * closed and, in the same instant, the opening leg of a new round trip for
 * the side it flipped into. `add`/`reduce` are non-terminal (they don't
 * start or end a round trip), but every fill from the `open` through the
 * terminal `close`/`flip` (inclusive) — including any `reduce` fills along
 * the way — is summed into the round trip's PnL: `reduce` fills can carry
 * real realized `closed_pnl` too, not just the final closing fill.
 *
 * A `close`/`flip`/`liquidation` seen with no matching prior `open` in our
 * data (the position was opened before this address's recorded history
 * began) cannot be reconstructed as a complete round trip — it is skipped
 * rather than guessed at.
 */
@Injectable()
export class RoundTripService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async reconstructRoundTrips(address: string, coin?: string): Promise<RoundTrip[]> {
    const conditions = [eq(actions.chain, CHAIN_DEFAULT), eq(actions.address, address)];
    if (coin) conditions.push(eq(actions.coin, coin));

    const rows = await this.db
      .select()
      .from(actions)
      .where(and(...conditions))
      .orderBy(actions.ts);

    const byCoin = new Map<string, ActionRow[]>();
    for (const row of rows) {
      const list = byCoin.get(row.coin) ?? [];
      list.push(row);
      byCoin.set(row.coin, list);
    }

    // Collect every terminal action's fill_ids first so the closed_pnl sums
    // can be fetched in one batched query instead of one round trip per
    // closing action.
    interface PendingTrip {
      address: string;
      coin: string;
      side: string;
      openTs: Date;
      closeTs: Date;
      fillIds: bigint[];
    }
    const pending: PendingTrip[] = [];

    for (const [coinName, coinActions] of byCoin) {
      let openAction: ActionRow | undefined;
      // Every fill from the `open` through the terminal `close`/`flip`
      // (inclusive) contributes to the round trip's PnL — opens/adds
      // realize ~0 but `reduce` fills can carry real realized PnL too, not
      // just the final closing fill (correction from the original M2 brief:
      // §11 "直接加總平倉 fill 的 closed_pnl" means every closing fill along
      // the way, not only the last one).
      let accumulatedFillIds: bigint[] = [];

      for (const action of coinActions) {
        if (action.kind === "open") {
          openAction = action;
          accumulatedFillIds = [...action.fillIds];
        } else if (action.kind === "add" || action.kind === "reduce") {
          if (openAction) accumulatedFillIds.push(...action.fillIds);
        } else if (action.kind === "close" || action.kind === "flip" || action.kind === "liquidation") {
          if (openAction) {
            pending.push({
              address,
              coin: coinName,
              side: openAction.side,
              openTs: openAction.ts,
              closeTs: action.ts,
              fillIds: [...accumulatedFillIds, ...action.fillIds],
            });
          }
          // A flip is terminal for the old side and immediately opens a new
          // round trip for the side it flipped into. The flip's own fills
          // already had their closed_pnl counted against the OLD round
          // trip above — starting the new round trip's fill list empty
          // (rather than re-including them) avoids double-counting that
          // same closed_pnl into the new position's PnL too.
          openAction = action.kind === "flip" ? action : undefined;
          accumulatedFillIds = [];
        }
      }
    }

    if (pending.length === 0) return [];

    const allFillIds = [...new Set(pending.flatMap((p) => p.fillIds))];
    const pnlByTid = new Map<string, number>();
    if (allFillIds.length > 0) {
      const fillRows = await this.db
        .select({ tid: fills.tid, closedPnl: fills.closedPnl })
        .from(fills)
        // tid is shared with the counterparty's fill: scope to this address.
        .where(
          and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), inArray(fills.tid, allFillIds)),
        );
      for (const row of fillRows) {
        pnlByTid.set(row.tid.toString(), row.closedPnl === null ? 0 : Number(row.closedPnl));
      }
    }

    return pending
      .map((p) => {
        const pnl = p.fillIds.reduce((sum, tid) => sum + (pnlByTid.get(tid.toString()) ?? 0), 0);
        return {
          address: p.address,
          coin: p.coin,
          side: p.side,
          openTs: p.openTs,
          closeTs: p.closeTs,
          pnl,
          holdTimeSeconds: Math.max(0, (p.closeTs.getTime() - p.openTs.getTime()) / 1000),
        };
      })
      .sort((a, b) => a.closeTs.getTime() - b.closeTs.getTime());
  }

  /** Fraction of complete round trips closed within [sinceTs, now] that were
   * wins (`pnl > 0`). `coin` narrows to one coin (N1 usage); omit it for the
   * address-wide rate (D2 usage). Returns `null` if there were zero round
   * trips in the window — never divides by zero / reports a bogus 0%. */
  async winRate(address: string, coin: string | undefined, sinceTs: Date): Promise<number | null> {
    const trips = await this.reconstructRoundTrips(address, coin);
    const windowed = trips.filter((t) => t.closeTs >= sinceTs);
    if (windowed.length === 0) return null;
    const wins = windowed.filter((t) => t.pnl > 0).length;
    return wins / windowed.length;
  }

  /** Sum of round-trip PnL closed within [sinceTs, now] (D2's 7d/30d realized PnL). */
  async realizedPnl(address: string, sinceTs: Date, coin?: string): Promise<number> {
    const trips = await this.reconstructRoundTrips(address, coin);
    return trips.filter((t) => t.closeTs >= sinceTs).reduce((sum, t) => sum + t.pnl, 0);
  }

  /** Average hold time across every reconstructed round trip (all-time —
   * the PRD doesn't specify a window for this D2 column, judgment call).
   * `null` if there are no complete round trips yet. */
  async avgHoldTimeSeconds(address: string): Promise<number | null> {
    const trips = await this.reconstructRoundTrips(address);
    if (trips.length === 0) return null;
    return trips.reduce((sum, t) => sum + t.holdTimeSeconds, 0) / trips.length;
  }
}
