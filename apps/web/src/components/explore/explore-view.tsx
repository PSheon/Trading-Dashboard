"use client";

import type { TraderWindow } from "@trading-dashboard/shared";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "@/components/page";
import { TradersTable } from "@/components/traders/traders-table";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { useSiteSettings, useSparklines, useTraders, type TraderSort } from "@/lib/queries";

const PAGE_SIZE = 25;
const MIN_VALUES = [0, 10_000, 100_000, 1_000_000, 10_000_000];
const WINDOWS: TraderWindow[] = ["day", "week", "month", "allTime"];

export function ExploreView() {
  const { t, format } = useI18n();
  const params = useSearchParams();
  const [window, setWindow] = useState<TraderWindow>("month");
  const [sort, setSort] = useState<TraderSort>("pnl");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(query);
  const [minValue, setMinValue] = useState(0);
  const [page, setPage] = useState(0);
  const settings = useSiteSettings();
  const [hideVaultsChoice, setHideVaultsChoice] = useState<boolean | null>(null);
  const hideVaults = hideVaultsChoice ?? settings.data?.hideVaults;

  // The top-bar search lands here with ?q= (also while already on Explore).
  const urlQ = params.get("q") ?? "";
  const [seenUrlQ, setSeenUrlQ] = useState(urlQ);
  if (urlQ !== seenUrlQ) {
    setSeenUrlQ(urlQ);
    setQuery(urlQ);
    setQ(urlQ);
    setPage(0);
  }

  // Debounce typing into the query.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const traders = useTraders({
    window,
    sort,
    order,
    q: q || undefined,
    minAccountValue: minValue || undefined,
    hideVaults,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const sparklines = useSparklines(traders.data?.items.map((i) => i.address) ?? [], window === "day" ? "week" : window);
  const total = traders.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function onSort(next: TraderSort) {
    if (next === sort) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else {
      setSort(next);
      setOrder("desc");
    }
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("explore.title")} subtitle={t("explore.subtitle")} />

      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented
          variant="pill"
          size="md"
          value={window}
          onChange={(w) => {
            setWindow(w);
            setPage(0);
          }}
          options={WINDOWS.map((w) => ({ value: w, label: t(`windows.${w}`) }))}
        />
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("explore.search")}
            aria-label={t("explore.search")}
            className="h-10 w-full rounded-full bg-raised pr-4 pl-10 text-sm outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <label className="flex h-10 items-center gap-2 rounded-full bg-raised pr-2 pl-4 text-sm">
          <span className="text-muted-foreground">{t("explore.minAccountValue")}</span>
          <select
            value={minValue}
            onChange={(e) => {
              setMinValue(Number(e.target.value));
              setPage(0);
            }}
            className="h-8 rounded-full bg-transparent pr-1 font-semibold outline-none"
          >
            {MIN_VALUES.map((v) => (
              <option key={v} value={v} className="bg-popover">
                {v === 0 ? t("explore.anyValue") : `≥ ${format.usd(v, { compact: true })}`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(hideVaults)}
          onClick={() => {
            setHideVaultsChoice(!hideVaults);
            setPage(0);
          }}
          className="flex h-10 items-center gap-2.5 rounded-full bg-raised px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              hideVaults ? "bg-primary" : "bg-border-strong",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-foreground transition-[left]",
                hideVaults ? "left-[18px]" : "left-0.5",
              )}
            />
          </span>
          {t("explore.hideVaults")}
        </button>
        <div className="num ml-auto flex flex-col items-end text-xs text-muted-foreground">
          {traders.data ? <span>{t("explore.total", { total: format.num(total, 0) })}</span> : null}
          {traders.data?.updatedAt ? (
            <span className="text-subtle-foreground">
              {t("explore.updated", { time: format.relative(traders.data.updatedAt) })}
            </span>
          ) : null}
        </div>
      </div>

      <Panel className="overflow-hidden">
        {traders.isError ? (
          <ErrorState message={traders.error.message} onRetry={() => traders.refetch()} />
        ) : !traders.data ? (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : traders.data.items.length === 0 ? (
          <EmptyState icon={Search} title={t("explore.noResults")} />
        ) : (
          <TradersTable
            rows={traders.data.items}
            window={window}
            rankOffset={page * PAGE_SIZE}
            sparklines={sparklines.data ?? {}}
            sortState={{ sort, order }}
            onSort={onSort}
            loading={traders.isFetching && traders.isPlaceholderData}
          />
        )}
        {traders.data && total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
              {t("common.prev")}
            </Button>
            <span className="num text-xs text-muted-foreground">
              {t("common.page", { page: page + 1, pages })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("common.next")}
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
