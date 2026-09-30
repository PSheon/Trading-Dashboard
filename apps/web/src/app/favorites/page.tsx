import { Suspense } from "react";

import { FavoritesView } from "@/components/favorites/favorites-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.favorites.title);

export default function FavoritesPage() {
  // useSearchParams (?tab=, ?view=) needs a Suspense boundary.
  return (
    <Suspense>
      <FavoritesView />
    </Suspense>
  );
}
