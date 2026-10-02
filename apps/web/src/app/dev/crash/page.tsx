import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = { title: "Crash", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Lab only: a page that throws while rendering, to see and test the
 * route error boundary (app/error.tsx). */
export default function CrashPage() {
  if (!labEnabled()) notFound();
  throw new Error("The lab's crash page threw on purpose");
}
