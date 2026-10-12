import { headers } from "next/headers";
import { Suspense } from "react";

import { AccountDeletedToast } from "@/components/home/account-deleted-toast";
import { HomeSkeleton, HomeView } from "@/components/home/home-view";
import { clientAddress } from "@/lib/client-address";
import { APP_NAME } from "@/lib/config";
import type { HomeBoardsResponse } from "@/lib/contracts";
import { seo } from "@/lib/seo";
import { prefetchPublic } from "@/lib/server-prefetch";

export const generateMetadata = seo("/", (m) => ({ title: `${m.meta.homeTitle} | ${APP_NAME}`, description: m.meta.pages.home, absolute: true }));

/** The rows are read on the server (the api serves them from its 30 s pool
 * snapshot), so the first HTML already shows traders. The shell streams at
 * once with skeleton rows (no read of its own); when the api is slow or
 * down the page falls back to the browser's own fetch, as before. */
export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <PrefetchedHome />
    </Suspense>
  );
}

async function PrefetchedHome() {
  const client = clientAddress(await headers());
  const home = await prefetchPublic<HomeBoardsResponse>("/discover/home", { client });
  return (
    <>
      <HomeView initial={{ home }} />
      {/* `?accountDeleted=1` after a self-service deletion: one toast. */}
      <Suspense fallback={null}><AccountDeletedToast /></Suspense>
    </>
  );
}
