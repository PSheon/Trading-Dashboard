import type { Metadata } from "next";
import { Suspense } from "react";

import { FullLeaderboardView } from "@/components/explore/full-leaderboard-view";
import { renderNotFound } from "@/components/shell/not-found-view";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = {
  title: "Full leaderboard",
  robots: { index: false, follow: false },
};

/** The whole official leaderboard (≈19k traders) with Orbie's filters and
 * the indexed-trader search (?q=). CopyDog has no such page, so it lives in
 * the lab, linked from its extras screen. */
export default async function FullLeaderboardPage() {
  if (!labEnabled()) return renderNotFound();
  // useSearchParams (?q=) needs a Suspense boundary.
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6">
      <Suspense>
        <FullLeaderboardView />
      </Suspense>
    </main>
  );
}
