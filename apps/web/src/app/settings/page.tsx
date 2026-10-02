import { Suspense } from "react";

import { SettingsView } from "@/components/settings/settings-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/settings", (m) => ({ title: m.settings.title, index: false }));

/** The tab / phone sub-view live in the query string (useSearchParams). */
export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
