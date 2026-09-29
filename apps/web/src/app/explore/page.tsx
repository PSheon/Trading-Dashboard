import { Suspense } from "react";

import { ExploreView } from "@/components/explore/explore-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.explore.title);

export default function ExplorePage() {
  // useSearchParams (?q= from the top-bar search) needs a Suspense boundary.
  return (
    <Suspense>
      <ExploreView />
    </Suspense>
  );
}
