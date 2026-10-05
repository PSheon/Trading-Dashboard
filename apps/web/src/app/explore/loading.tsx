import { BoardsView } from "@/components/explore/boards-view";

/** While this route's server part is on the way: the page itself in its
 * loading state (header, board chips, card / row skeletons). Its board
 * query starts here and the page picks it up from the cache, so the swap
 * moves nothing. */
export default function Loading() {
  return <BoardsView />;
}
