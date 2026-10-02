import type { CoinBoardResponse } from "./contracts";

/**
 * Whether `/coins/<coin>` names something that is not a Hyperliquid market:
 * such a URL is the 404 page. The api says so with `listed` (Hyperliquid's
 * own universe, main dex and HIP-3). A real market none of our tracked
 * traders has traded is NOT unknown: it is the page with CopyDog's
 * 「尚無市場資料」 empty state, HTTP 200 (owner, 2026-10-02; before that such a
 * market was a 404 too).
 *
 * `null` while it can't be told: no answer yet, or an api that does not
 * know the universe right now (`listed` null or absent). The page then
 * renders; a real market must not turn into a 404 because the api was slow
 * or had just started.
 */
export function coinIsUnknown(board: Pick<CoinBoardResponse, "items" | "stats"> & { listed?: boolean | null } | null | undefined): boolean | null {
  if (!board) return null;
  if (board.items.length > 0 || board.stats.traders > 0) return false;
  return board.listed == null ? null : !board.listed;
}
