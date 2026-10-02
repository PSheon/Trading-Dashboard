"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  traderSearchQuerySchema,
  type TraderSearchResponse,
} from "@/lib/contracts";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n/provider";
import { Panel, Skeleton, ErrorState } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { TraderName, AddressText } from "@/components/traders/trader-name";

export function TraderSearchResults({ query }: { query: string }) {
  const { t } = useI18n();
  const parsed = traderSearchQuerySchema.safeParse({ q: query });
  const q = parsed.success ? parsed.data.q : "";
  const result = useQuery({
    queryKey: ["trader-search", q],
    enabled: Boolean(q),
    queryFn: ({ signal }) =>
      api.get<TraderSearchResponse>(
        `/trader-search?q=${encodeURIComponent(q)}`,
        signal,
      ),
    staleTime: 30_000,
  });
  if (!query.trim()) return null;
  return (
    <Panel
      role="region"
      className="space-y-3 p-4"
      aria-labelledby="trader-search-title"
    >
      <h2 id="trader-search-title" className="font-semibold">
        {t("research.searchTitle")}
      </h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("research.searchHint")}
      </p>
      {!parsed.success ? (
        <p className="text-sm text-muted-foreground">
          {t("research.queryLength")}
        </p>
      ) : result.isError && !result.data ? (
        <ErrorState
          message={result.error.message}
          onRetry={() => result.refetch()}
        />
      ) : !result.data ? (
        <Skeleton className="h-24" />
      ) : (
        <TraderMatches data={result.data} />
      )}
    </Panel>
  );
}
export function TraderMatches({ data }: { data: TraderSearchResponse }) {
  const { t } = useI18n();
  return (
    <>
      {!data.items.length && (
        <p className="text-sm text-muted-foreground">
          {t("research.noMatches")}
        </p>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {data.items.map((item) => (
          <li key={item.address} className="min-w-0">
            <Link
              href={`/trader/${item.address}`}
              className="flex min-w-0 items-center gap-3 rounded-xl bg-raised p-3 outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AddressAvatar seed={item.address} size={32} />
              <div className="min-w-0 flex-1">
                <TraderName trader={item} className="text-sm font-medium" />
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <AddressText address={item.address} />
                  {item.xHandle && (
                    <span className="break-all">@{item.xHandle}</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t(
                    item.source === "kol"
                      ? "research.registry"
                      : "research.leaderboard",
                  )}
                  {!item.hasLeaderboardData && ` · ${t("research.noStats")}`}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {data.hasMore && (
        <p className="text-xs text-muted-foreground">{t("research.more")}</p>
      )}
    </>
  );
}
