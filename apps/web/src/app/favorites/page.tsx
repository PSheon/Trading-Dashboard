import { Suspense } from "react";

import { FavoritesView } from "@/components/favorites/favorites-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/favorites", (m) => ({ title: m.favorites.title, index: false }));

export default function FavoritesPage() {
  // useSearchParams (?tab=, ?view=) needs a Suspense boundary.
  return (
    <Suspense>
      <FavoritesView />
    </Suspense>
  );
}
