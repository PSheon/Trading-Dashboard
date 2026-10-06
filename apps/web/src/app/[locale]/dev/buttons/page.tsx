import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonGallery } from "@/components/dev/button-gallery";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = {
  title: "Busy buttons",
  robots: { index: false, follow: false },
};

/** Every button variant and size in its busy state, for review (the lab:
 * on in development, off in production unless NEXT_DEV_LAB=1). */
export default function ButtonGalleryPage() {
  if (!labEnabled()) notFound();
  return <ButtonGallery />;
}
