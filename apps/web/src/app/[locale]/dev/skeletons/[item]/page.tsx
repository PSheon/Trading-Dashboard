import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SkeletonFrame } from "@/components/dev/skeleton-frame";
import { SKELETON_IDS } from "@/components/dev/skeleton-ids";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = {
  title: "Skeleton frame",
  robots: { index: false, follow: false },
};

/** One item of the skeleton gallery, alone, for its framed preview. */
export default async function SkeletonFramePage({ params }: PageProps<"/[locale]/dev/skeletons/[item]">) {
  if (!labEnabled()) notFound();
  const { item } = await params;
  if (!SKELETON_IDS.includes(item)) notFound();
  // useSearchParams (?state=, ?theme=) needs a Suspense boundary.
  return <Suspense><SkeletonFrame id={item} /></Suspense>;
}
