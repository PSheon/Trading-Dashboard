import { PortfolioView } from "@/components/portfolio-view";

/** While this route's server part is on the way: the page itself in its
 * loading state (total card, 模擬帳戶 and chart cards, the copy list's
 * rows). Its queries start here and the page picks them up from the cache. */
export default function Loading() {
  return <PortfolioView />;
}
