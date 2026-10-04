import { headers } from "next/headers";
import { Suspense } from "react";

import { HomeView } from "@/components/home/home-view";
import { clientAddress } from "@/lib/client-address";
import { APP_NAME } from "@/lib/config";
import type { HomeBoardsResponse, PublicSettings } from "@/lib/contracts";
import { seo } from "@/lib/seo";
import { prefetchPublic } from "@/lib/server-prefetch";

export const generateMetadata = seo("/", (m) => ({ title: `${m.meta.homeTitle} | ${APP_NAME}`, description: m.meta.pages.home, absolute: true }));

/** The rows are read on the server (the api serves them from its 30 s pool
 * snapshot), so the first HTML already shows traders. The shell streams at
 * once; when the api is slow or down the page falls back to the browser's
 * own fetch, as before. */
export default function HomePage() {
  return (
    <Suspense fallback={<HomeView />}>
      <PrefetchedHome />
    </Suspense>
  );
}

async function PrefetchedHome() {
  const client = clientAddress(await headers());
  const [home, settings] = await Promise.all([
    prefetchPublic<HomeBoardsResponse>("/discover/home", { client }),
    prefetchPublic<PublicSettings>("/settings", { client }),
  ]);
  return <HomeView initial={{ home, settings }} />;
}
