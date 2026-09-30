import { Suspense } from "react";

import { PortfolioView } from "@/components/portfolio-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.portfolio.title);

/** The open copy lives in the query string (`?copy=<id>`, useSearchParams). */
export default function PortfolioPage() {
  return (
    <Suspense>
      <PortfolioView />
    </Suspense>
  );
}
