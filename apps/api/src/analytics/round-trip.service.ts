import { Injectable } from "@nestjs/common";

import { RoundTripRepository, type ActionRow } from "./round-trip.repository.js";

/** One reconstructed "open to flat" position, per §11 決策紀錄 "勝率與 PnL 單位":
 * "以一次完整倉位（開到平）為一筆；直接加總平倉 fill 的 closed_pnl". */
export interface RoundTrip {
  address: string;
  coin: string;
  /** The position's side, long or short: the opening action's. The round
   * trip a flip closes keeps the side it came from; the one the flip opens
   * carries the flip's new side (`actions.side` of a flip is the side after it). */
  side: string;
  openTs: Date;
  closeTs: Date;
  /** Sum of `closed_pnl` across the closing/flip action's fills. */
  pnl: number;
  holdTimeSeconds: number;
}

/**
 * Realized round trips from `actions` + `fills` (§11 "勝率與 PnL 單位"); PnL
 * is only the sum of Hyperliquid's `closed_pnl`, never re-derived.
 *
 * A round trip runs from `open` to the next `close`/`flip`/`liquidation` per
 * (address, coin); a flip also opens the next one. Every fill from open
 * through the terminal action counts (`reduce` fills realize PnL too). A
 * terminal action with no prior `open` in our data is skipped.
 */
@Injectable()
export class RoundTripService {
  constructor(private readonly repository: RoundTripRepository) {}

  async reconstructRoundTrips(address: string, coin?: string): Promise<RoundTrip[]> {
    return this.reconstructRoundTripsMany([address], coin);
  }

  /** Batch callers must bound the address window; fills remain keyed by
   * address + tid. `since` bounds the history read: a round trip opened
   * before it is skipped, like one opened before our records began. */
  async reconstructRoundTripsMany(addresses: string[], coin?: string, since?: Date): Promise<RoundTrip[]> {
    if (addresses.length === 0) return [];
    const rows = await this.repository.history(addresses, coin, since);

    const byCoin = new Map<string, ActionRow[]>();
    for (const row of rows) {
      const key = `${row.address}\0${row.coin}`;
      const list = byCoin.get(key) ?? [];
      list.push(row);
      byCoin.set(key, list);
    }

    // Collect fill_ids first so closed_pnl is fetched in one query.
    interface PendingTrip {
      address: string;
      coin: string;
      side: string;
      openTs: Date;
      closeTs: Date;
      fillIds: bigint[];
    }
    const pending: PendingTrip[] = [];

    for (const coinActions of byCoin.values()) {
      const { address, coin: coinName } = coinActions[0]!;
      let openAction: ActionRow | undefined;
      // Every fill from `open` through the terminal action, inclusive.
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
          // A flip opens the next round trip with an empty fill list: its
          // fills' closed_pnl already counted for the old one.
          openAction = action.kind === "flip" ? action : undefined;
          accumulatedFillIds = [];
        }
      }
    }

    if (pending.length === 0) return [];

    const allFillIds = [...new Set(pending.flatMap((p) => p.fillIds))];
    const pnlByTid = await this.repository.pnlByTid(addresses, allFillIds);

    return pending
      .map((p) => {
        const pnl = p.fillIds.reduce((sum, tid) => sum + (pnlByTid.get(`${p.address}\0${tid}`) ?? 0), 0);
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

  /** Share of round trips closed since `sinceTs` with `pnl > 0`; null when
   * there are none (never a bogus 0%). */
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

  /** All-time average hold (the PRD names no window); null with no trips. */
  async avgHoldTimeSeconds(address: string): Promise<number | null> {
    const trips = await this.reconstructRoundTrips(address);
    if (trips.length === 0) return null;
    return trips.reduce((sum, t) => sum + t.holdTimeSeconds, 0) / trips.length;
  }
}
