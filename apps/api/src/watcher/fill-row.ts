import { CHAIN_DEFAULT } from "@trading-dashboard/shared";

import type { HlUserFill } from "../hyperliquid/types.js";

/** Shared HlUserFill → `fills` row mapping, used by both the regular poll
 * loop (watcher.service.ts) and A5 backfill (backfill.service.ts) so the
 * two code paths can never drift on column mapping. */
export function toFillRow(address: string, f: HlUserFill) {
  return {
    chain: CHAIN_DEFAULT,
    tid: BigInt(f.tid),
    address,
    coin: f.coin,
    side: f.side,
    dir: f.dir,
    px: f.px,
    sz: f.sz,
    fee: f.fee,
    closedPnl: f.closedPnl ?? null,
    hash: f.hash ?? null,
    ts: new Date(f.time),
    raw: f as unknown as Record<string, unknown>,
  };
}
