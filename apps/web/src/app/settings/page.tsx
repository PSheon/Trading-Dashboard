import { Suspense } from "react";

import { SettingsView } from "@/components/settings/settings-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.settings.title);

/** The tab / phone sub-view live in the query string (useSearchParams). */
export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
