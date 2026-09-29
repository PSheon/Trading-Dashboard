import { Suspense } from "react";

import { InsightsView } from "@/components/insights/insights-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.insights.title);

export default function InsightsPage() {
  // ?coin= comes from the home page's market chips.
  return (
    <Suspense>
      <InsightsView />
    </Suspense>
  );
}
