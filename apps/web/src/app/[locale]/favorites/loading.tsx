import { FavoritesView } from "@/components/favorites/favorites-view";

/** While this route's server part is on the way: the page itself in its
 * loading state (tabs, group chips, card or table skeletons). Its queries
 * start here and the page picks them up from the cache. */
export default function Loading() {
  return <FavoritesView />;
}
