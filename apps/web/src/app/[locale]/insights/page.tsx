import { Suspense } from "react";

import { InsightsView } from "@/components/insights/insights-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/insights", (m) => ({ title: m.insights.title, description: m.meta.pages.insights }));

export default function InsightsPage() {
  // ?coin= comes from the home page's market chips.
  return (
    <Suspense>
      <InsightsView />
    </Suspense>
  );
}
