import type { Metadata } from "next";

import { renderNotFound } from "@/components/shell/not-found-view";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = { title: "Crash", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Lab only: a page that throws while rendering, to see and test the
 * route error boundary (app/error.tsx). */
export default async function CrashPage() {
  if (!labEnabled()) return renderNotFound();
  throw new Error("The lab's crash page threw on purpose");
}
