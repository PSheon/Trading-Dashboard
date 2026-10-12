import { Suspense } from "react";

import { BoardsView } from "@/components/explore/boards-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/explore", (m) => ({ title: m.discover.title, description: m.meta.pages.explore }));

export default function ExplorePage() {
  // useSearchParams (?board= from the home tiles) needs a Suspense boundary.
  return (
    <Suspense>
      <BoardsView />
    </Suspense>
  );
}
