import { Suspense } from "react";

import { FullLeaderboardView } from "@/components/explore/full-leaderboard-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.explore.title);

/** The whole official leaderboard (≈19k traders) with Orbie's filters,
 * linked from the bottom of Explore ("查看完整排行榜"). */
export default function FullLeaderboardPage() {
  // useSearchParams (?q= from the top-bar search) needs a Suspense boundary.
  return (
    <Suspense>
      <FullLeaderboardView />
    </Suspense>
  );
}
