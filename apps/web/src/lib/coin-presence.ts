import type { CoinBoardResponse } from "./contracts";

/**
 * Whether `/coins/<coin>` names a market the site has nothing for: the pool
 * has traders with results, and none of them traded this coin. Such a URL
 * is the 404 page (owner's rule, as for a trader address with no data;
 * CopyDog answers 200 with "尚無市場資料"). `null` while that can't be told:
 * no answer yet, or a pool that is still filling in — a real market must
 * not turn into a 404 because the api was slow or had just started.
 */
export function coinIsUnknown(board: Pick<CoinBoardResponse, "items" | "stats" | "pool"> | null | undefined): boolean | null {
  if (!board) return null;
  if (board.items.length > 0 || board.stats.traders > 0) return false;
  return board.pool.ready > 0 ? true : null;
}
