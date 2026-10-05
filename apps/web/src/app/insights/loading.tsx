import { InsightsView } from "@/components/insights/insights-view";

/** While this route's server part is on the way: the page itself in its
 * loading state (split cards, chart and treemap wells, the wallets table's
 * rows). Its queries start here and the page picks them up from the cache. */
export default function Loading() {
  return <InsightsView />;
}
