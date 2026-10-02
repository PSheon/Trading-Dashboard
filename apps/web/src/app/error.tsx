"use client";

import { RouteError } from "@/components/route-error";
import { useI18n } from "@/i18n/provider";

/** The error boundary of every route: it sits inside the root layout, so
 * the shell (rail, top bar, tab bar) and the language stay. */
export default function RouteErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { t } = useI18n();
  return <RouteError error={error} retry={retry} title={t("common.error")} retryLabel={t("common.retry")} homeLabel={t("notFound.home")} />;
}
