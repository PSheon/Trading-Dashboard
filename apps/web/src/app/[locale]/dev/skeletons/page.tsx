import type { Metadata } from "next";

import { SkeletonGallery } from "@/components/dev/skeleton-gallery";
import { renderNotFound } from "@/components/shell/not-found-view";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = {
  title: "Loading skeletons",
  robots: { index: false, follow: false },
};

/** Every route's and component's loading state on one page, for review
 * (the lab: on in development, off in production unless NEXT_DEV_LAB=1). */
export default async function SkeletonGalleryPage() {
  if (!labEnabled()) return renderNotFound();
  return <SkeletonGallery />;
}
