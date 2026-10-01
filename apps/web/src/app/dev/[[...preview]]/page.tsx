import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { concepts, previousConcepts, screenIds } from "@/components/dev/concepts";
import { DesignLab } from "@/components/dev/design-lab";
import { getLocale } from "@/i18n/server";
import { contentBlocks } from "@/lib/content";

export const metadata: Metadata = {
  title: "Design lab",
  robots: { index: false, follow: false },
};

/** The lab (design concepts and the Orbie-only extras) is a development
 * tool: a production server answers 404 unless NEXT_DEV_LAB=1 is set on it. */
function labEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_DEV_LAB === "1";
}

export default async function DevPage({ params }: { params: Promise<{ preview?: string[] }> }) {
  if (!labEnabled()) notFound();
  const { preview = [] } = await params;
  const [concept = "wealth", screen = "home"] = preview;
  if (preview.length > 2 || ![...concepts, ...previousConcepts].some((item) => item.id === concept) || !screenIds.includes(screen)) notFound();
  const numbers = contentBlocks("numbers", await getLocale());
  return <Suspense><DesignLab concept={concept} screen={screen} numbers={numbers} /></Suspense>;
}
