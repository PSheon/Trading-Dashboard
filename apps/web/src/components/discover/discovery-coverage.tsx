"use client";

import Link from "next/link";

import { useI18n } from "@/i18n/provider";
import type { BoardResponse } from "@/lib/contracts";

type Coverage = Pick<BoardResponse, "pool" | "freshness" | "rankingScope">;

/** A quiet disclosure beside the results, including when the pool is empty. */
export function DiscoveryCoverage({ data }: { data: Partial<Coverage> }) {
  const { t, format } = useI18n();
  if (!data.pool || data.rankingScope !== "candidate_pool") return null;
  const { pool, freshness } = data;
  return (
    <details className="rounded-xl border border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("discover.dataCoverage.summary", { ready: String(pool.ready), total: String(pool.total) })}
      </summary>
      <div className="mt-3 space-y-1.5 border-t border-border pt-3">
        <p>{t("discover.dataCoverage.scope")}</p>
        {pool.tradesReady !== undefined ? <p>{t("discover.dataCoverage.trades", { ready: String(pool.tradesReady), total: String(pool.total) })}</p> : null}
        {freshness?.oldestUpdatedAt && freshness.newestUpdatedAt ? (
          <p>{t("discover.dataCoverage.updated", { oldest: format.dateTime(freshness.oldestUpdatedAt), newest: format.dateTime(freshness.newestUpdatedAt) })}</p>
        ) : <p>{t("discover.dataCoverage.unknown")}</p>}
        {(freshness?.missingTimestamps ?? 0) > 0 ? <p>{t("discover.dataCoverage.missing")}</p> : null}
        <p>{t("discover.dataCoverage.history")}</p>
        <p>{t("discover.dataCoverage.score")}</p>
        <Link href="/methodology" className="inline-block rounded-sm underline underline-offset-2 focus-visible:outline-2">{t("methodology.title")}</Link>
      </div>
    </details>
  );
}
