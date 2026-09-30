import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { concepts, previousConcepts, screenIds } from "@/components/dev/concepts";
import { DesignLab } from "@/components/dev/design-lab";

export const metadata: Metadata = {
  title: "Design lab",
  robots: { index: false, follow: false },
};

export default async function DevPage({ params }: { params: Promise<{ preview?: string[] }> }) {
  const { preview = [] } = await params;
  const [concept = "wealth", screen = "home"] = preview;
  if (preview.length > 2 || ![...concepts, ...previousConcepts].some((item) => item.id === concept) || !screenIds.includes(screen)) notFound();
  return <Suspense><DesignLab concept={concept} screen={screen} /></Suspense>;
}
