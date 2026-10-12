import { Suspense } from "react";

import { PortfolioView } from "@/components/portfolio-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/portfolio", (m) => ({ title: m.portfolio.title, index: false }));

/** The open copy lives in the query string (`?copy=<id>`, useSearchParams). */
export default function PortfolioPage() {
  return (
    <Suspense>
      <PortfolioView />
    </Suspense>
  );
}
