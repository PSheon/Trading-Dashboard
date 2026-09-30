import { Suspense } from "react";

import { BoardsView } from "@/components/explore/boards-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.discover.title);

export default function ExplorePage() {
  // useSearchParams (?board= from the home tiles) needs a Suspense boundary.
  return (
    <Suspense>
      <BoardsView />
    </Suspense>
  );
}
