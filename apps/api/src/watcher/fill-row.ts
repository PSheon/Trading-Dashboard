import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { HlUserFill } from "../hyperliquid/types.js";

const ZERO_HASH = /^0x0*$/;

/** Shared HlUserFill → `fills` row mapping, used by both the regular poll
 * loop (watcher.service.ts) and A5 backfill (backfill.service.ts) so the
 * two code paths can never drift on column mapping. A TWAP slice keeps its
 * `twapId` in `raw`. */
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
    // TWAP slices carry 0x0…0, which names no transaction.
    hash: f.hash && !ZERO_HASH.test(f.hash) ? f.hash : null,
    ts: new Date(f.time),
    raw: f as unknown as Record<string, unknown>,
  };
}
