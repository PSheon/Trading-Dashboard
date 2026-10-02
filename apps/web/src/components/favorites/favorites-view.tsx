"use client";

import { Bell, Bookmark, ChevronDown, Send, Star, X, Zap } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { AlertBell, alertSummary } from "@/components/alerts/alert-bell";
import { BoardCard, BoardCardSkeleton } from "@/components/discover/board-card";
import { BoardSparkline, boardName, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { ViewToggle } from "@/components/explore/boards-view";
import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { FavoriteButton } from "@/components/traders/bits";
import { useI18n } from "@/i18n/provider";
import { useSetFavoriteAlert, useTelegramStatus } from "@/lib/alerts";
import { useAuth } from "@/lib/auth";
import { boardPnl, boardRoi, boardUsd } from "@/lib/board-format";
import type { ActionFeedItem, Favorite, FavoriteGroup, TraderCard } from "@/lib/contracts";
import { useFavoriteGroups, useTraderCards } from "@/lib/favorite-groups";
import { coinLabel, truncateAddress } from "@/lib/format";
import { useFavorites, useLiveActions, useSiteSettings, useSparklines, useToggleFavorite } from "@/lib/queries";
import { useNow } from "@/lib/use-now";
import { GroupChips, GroupTags } from "./groups";

type Tab = "saved" | "alerts" | "feed";
const TABS: Tab[] = ["saved", "alerts", "feed"];

/**
 * 收藏 (CopyDog's /hyperliquid/watchlist). Signed out: CopyDog's centred
 * prompt. Signed in: three tabs — 收藏 (group chips, explore cards in a grid
 * or CopyDog's watchlist table), 提醒 (Telegram alerts, edited in place,
 * "提醒 x / N") and 動態 (the live feed of favorites over the existing SSE;
 * new rows flash). Copies are on /portfolio, as on CopyDog.
 */
export function FavoritesView() {
  const { status } = useAuth();
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const [tab, setTab] = useState<Tab>(fromUrl && (TABS as string[]).includes(fromUrl) ? (fromUrl as Tab) : "saved");
  const [view, setView] = useState<"grid" | "list">(params.get("view") === "list" ? "list" : "grid");

  // The tab and layout follow the URL (?tab=alerts&view=list) so they can be shared.
  useEffect(() => {
    // Other parameters (campaign tags, ?tg= in fixture mode) are kept.
    const qs = new URLSearchParams(globalThis.location.search);
    if (tab !== "saved") qs.set("tab", tab);
    else qs.delete("tab");
    if (view !== "grid") qs.set("view", view);
    else qs.delete("view");
    const next = `${globalThis.location.pathname}${qs.size ? `?${qs}` : ""}`;
    if (next !== `${globalThis.location.pathname}${globalThis.location.search}`) globalThis.history.replaceState(null, "", next);
  }, [tab, view]);

  if (status === "loading") {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-11 w-full max-w-md" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <BoardCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }
  if (status !== "signedIn") return <SignedOut />;
  return <SignedIn tab={tab} onTab={setTab} view={view} onView={setView} />;
}

/** CopyDog's signed-out watchlist. Desktop: a large bookmark, heading,
 * line and a wide 登入 button, centred. Phones: the app's 收藏 title with
 * its ★ / 🔔 switch and a smaller prompt for each. */
function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  const [phoneTab, setPhoneTab] = useState<"saved" | "alerts">("saved");
  const disabled = status === "disabled";
  const PhoneIcon = phoneTab === "saved" ? Star : Bell;
  return (
    <>
      <div className="hidden min-h-[60vh] flex-col items-center gap-3 px-4 pt-[88px] text-center md:flex">
        <Bookmark className="mb-1 size-14 text-subtle-foreground" strokeWidth={1.5} aria-hidden />
        <h1 className="text-[28px] leading-[42px] font-semibold">{t("favorites.signInTitle")}</h1>
        <p className="text-muted-foreground">{t("favorites.signInBody")}</p>
        <button
          type="button"
          onClick={login}
          disabled={disabled}
          title={disabled ? t("topbar.loginUnavailable") : undefined}
          className="mt-5 h-14 w-[200px] rounded-full bg-primary text-base font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {t("common.signIn")}
        </button>
      </div>
      <div className="md:hidden">
        <div className="-mt-[7px] flex items-center justify-between">
          <p role="heading" aria-level={1} className="text-[28px] leading-[1.15] font-bold tracking-[-0.5px]">{t("favorites.title")}</p>
          <div role="tablist" aria-label={t("favorites.title")} className="flex rounded-full bg-raised p-1">
            {(["saved", "alerts"] as const).map((key) => {
              const Icon = key === "saved" ? Star : Bell;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={phoneTab === key}
                  aria-label={t(`favorites.tabs.${key}`)}
                  onClick={() => setPhoneTab(key)}
                  className={cn("flex h-8 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring", phoneTab === key ? "bg-raised-hover text-foreground" : "text-muted-foreground")}
                >
                  <Icon className="size-4" fill="currentColor" />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col items-center gap-2 pt-[57px] text-center">
          <PhoneIcon className="size-10 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          <p className="mt-2 text-base font-semibold">{t(phoneTab === "saved" ? "favorites.phoneSavedTitle" : "favorites.phoneAlertsTitle")}</p>
          <p className="text-sm text-muted-foreground">{t(phoneTab === "saved" ? "favorites.phoneSavedBody" : "favorites.phoneAlertsBody")}</p>
          <button
            type="button"
            onClick={login}
            disabled={disabled}
            className="mt-4 h-12 rounded-full bg-primary px-5 text-base font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {t("common.signIn")}
          </button>
        </div>
      </div>
    </>
  );
}

function SignedIn({ tab, onTab, view, onView }: { tab: Tab; onTab: (t: Tab) => void; view: "grid" | "list"; onView: (v: "grid" | "list") => void }) {
  const { t } = useI18n();
  const favorites = useFavorites();
  const groups = useFavoriteGroups();
  const settings = useSiteSettings();
  const telegram = useTelegramStatus();
  const feed = useLiveActions({ scope: "favorites", limit: 60 }, { enabled: true });
  const list = favorites.data ?? [];
  const alerting = list.filter((f) => f.alert.enabled).length;
  const max = settings.data?.maxAlertTraders;
  const feedRows = feed.query.data ?? [];

  const counts: Record<Tab, number | null> = { saved: favorites.data ? list.length : null, alerts: favorites.data ? alerting : null, feed: feed.query.data ? feedRows.length : null };

  let right: React.ReactNode = null;
  if (tab === "saved") right = <ViewToggle value={view} onChange={onView} />;
  if (tab === "alerts" && max !== undefined) {
    right = (
      <span className="flex items-center gap-2">
        <span className={cn("num text-sm font-semibold", alerting >= max ? "text-warning" : "text-muted-foreground")}>
          {t("favorites.alerts.count", { count: alerting, max })}
        </span>
        {telegram.data && !telegram.data.linked ? (
          <Link href="/settings" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
            <Send className="size-3.5" />
            {t("favorites.alerts.connect")}
          </Link>
        ) : null}
      </span>
    );
  }
  if (tab === "feed") {
    const live = feed.status === "live";
    right = (
      <span className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground" aria-live="polite">
        <span className={cn("size-2 rounded-full", live ? "animate-pulse bg-positive" : "bg-warning")} aria-hidden />
        {live ? t("favorites.feed.live") : t("favorites.feed.connecting")}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[1.75rem] font-extrabold tracking-tight md:text-[2rem]">{t("favorites.title")}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-full bg-raised p-1" role="tablist" aria-label={t("favorites.title")}>
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => onTab(key)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`favorites.tabs.${key}`)}
              {counts[key] !== null && counts[key] > 0 ? <span className={cn("num text-xs", tab === key ? "opacity-80" : "text-subtle-foreground")}>{counts[key]}</span> : null}
            </button>
          ))}
        </div>
        {right}
      </div>

      {favorites.isError && !favorites.data ? (
        <ErrorState message={t("favorites.error")} onRetry={() => favorites.refetch()} />
      ) : tab === "saved" ? (
        <SavedTab favorites={favorites.data} groups={groups.data ?? []} view={view} />
      ) : tab === "alerts" ? (
        <AlertsTab favorites={favorites.data} />
      ) : feed.query.errorUpdateCount > 0 && !feed.query.data ? (
        // Not a placeholder without end: the feed could not be read.
        <ErrorState message={t("favorites.error")} onRetry={() => feed.query.refetch()} />
      ) : (
        <FeedTab rows={feedRows} loading={!feed.query.data} highlight={feed.highlight} favorites={list} hasFavorites={list.length > 0} />
      )}
    </div>
  );
}

/** Cards whose pool figures are missing borrow the all-time sparkline the
 * trader pages use. */
function useCards(addresses: string[]) {
  const cards = useTraderCards(addresses);
  const missing = useMemo(() => (cards.data?.items ?? []).filter((c) => c.sparkline.length < 2).map((c) => c.address).slice(0, 30), [cards.data]);
  const sparks = useSparklines(missing, "allTime");
  const items = useMemo(() => (cards.data?.items ?? []).map((c) => {
    const series = c.sparkline.length < 2 ? sparks.data?.[c.address] : undefined;
    return series && series.length > 1 ? { ...c, sparkline: series.map((p) => p[1]) } : c;
  }), [cards.data, sparks.data]);
  return { ...cards, items };
}

type SortKey = "copyScore" | "accountValue" | "pnl" | "roi" | "pnl30d" | "winRate" | "sharpe" | "maxDrawdown";

function SavedTab({ favorites, groups, view }: { favorites: Favorite[] | undefined; groups: FavoriteGroup[]; view: "grid" | "list" }) {
  const { t } = useI18n();
  const now = useNow();
  const [active, setActive] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey | null>(null);
  const addresses = useMemo(() => (favorites ?? []).map((f) => f.address), [favorites]);
  const cards = useCards(addresses);
  const counts = useMemo(() => new Map(groups.map((g) => [g.id, g.addresses.filter((a) => addresses.includes(a)).length])), [groups, addresses]);
  const selected = groups.find((g) => g.id === active) ?? null;

  let items = cards.items;
  if (selected) items = items.filter((c) => selected.addresses.includes(c.address));
  if (sort) items = [...items].sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));

  if (!favorites) return <SavedSkeleton view={view} />;
  if (favorites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-card px-6 py-14 text-center">
        <Bookmark className="size-14 text-border-strong" strokeWidth={1.25} aria-hidden />
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-bold">{t("favorites.emptyTitle")}</h2>
          <p className="mx-auto max-w-[330px] text-muted-foreground">{t("favorites.emptyBody")}</p>
        </div>
        <Link href="/explore" className="inline-flex h-11 items-center rounded-full bg-primary px-5 font-bold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring">
          {t("favorites.explore")}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <GroupChips groups={groups} counts={counts} total={favorites.length} active={active} onSelect={setActive} />
      {cards.isError && !cards.data ? (
        <ErrorState message={t("favorites.error")} onRetry={() => cards.refetch()} />
      ) : !cards.data ? (
        <SavedSkeleton view={view} />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card py-12 text-center text-muted-foreground">{t("favorites.emptyGroup")}</p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((card) => (
            <BoardCard
              key={card.address}
              trader={card}
              pnlLabel={t("discover.pnl")}
              roiLabel={t("discover.roi")}
              now={now}
              accessory={<FavoriteButton address={card.address} favorite size="sm" className="-mt-1 -mr-1.5" />}
              tags={<GroupTags address={card.address} groups={groups} />}
            />
          ))}
        </div>
      ) : (
        <>
          <WatchlistTable items={items} groups={groups} sort={sort} onSort={setSort} />
          <ul className="flex flex-col gap-2 md:hidden">
            {items.map((card) => <MobileRow key={card.address} card={card} groups={groups} />)}
          </ul>
        </>
      )}
    </div>
  );
}

function SavedSkeleton({ view }: { view: "grid" | "list" }) {
  return view === "grid" ? (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => <BoardCardSkeleton key={i} />)}
    </div>
  ) : (
    <div className="flex flex-col gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
  );
}

function TraderCell({ card, subtitle, size = 44 }: { card: TraderCard; subtitle?: React.ReactNode; size?: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Link href={`/trader/${card.address}`} className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={boardName(card)}>
        <TraderAvatar trader={card} size={size} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={`/trader/${card.address}`} className="flex min-w-0 items-center gap-1 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <span className="truncate text-sm font-semibold">{boardName(card)}</span>
          {card.verified ? <VerifiedTick className="size-3.5" /> : null}
        </Link>
        {subtitle}
      </div>
    </div>
  );
}

function RowActions({ address }: { address: string }) {
  const { t } = useI18n();
  const { toggle, pending } = useToggleFavorite();
  return (
    <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => toggle(address, false)}
        disabled={pending === address}
        aria-label={t("favorites.remove")}
        title={t("favorites.remove")}
        className="inline-flex size-8 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-negative-soft hover:text-negative focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <X className="size-4" />
      </button>
      <AlertBell address={address} className="size-8" />
      <Link
        href={`/trader/${address}#copy-amount`}
        title={t("favorites.copyTooltip")}
        className="inline-flex h-8 items-center rounded-full bg-primary px-3.5 text-[0.8125rem] font-bold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("favorites.copy")}
      </Link>
    </span>
  );
}

/** CopyDog's watchlist table (desktop list view); headers sort descending. */
function WatchlistTable({ items, groups, sort, onSort }: { items: TraderCard[]; groups: FavoriteGroup[]; sort: SortKey | null; onSort: (s: SortKey | null) => void }) {
  const { t, format } = useI18n();
  const head = (key: SortKey, label: string) => (
    <th className="px-3 py-3 text-right text-[0.8125rem] font-semibold text-subtle-foreground" aria-sort={sort === key ? "descending" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sort === key ? null : key)}
        className={cn("inline-flex items-center gap-1 rounded whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", sort === key && "text-foreground")}
      >
        {label}
        {sort === key ? <ChevronDown className="size-3" /> : null}
      </button>
    </th>
  );
  const plain = (v: string) => <span className="num text-sm font-medium">{v}</span>;
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-border bg-card md:block">
      <table className="w-full min-w-[1080px] table-fixed border-collapse">
        <colgroup>
          <col style={{ width: "19%" }} /><col style={{ width: "10%" }} /><col style={{ width: "9%" }} /><col style={{ width: "8%" }} /><col style={{ width: "7%" }} />
          <col style={{ width: "8%" }} /><col style={{ width: "6%" }} /><col style={{ width: "6%" }} /><col style={{ width: "7%" }} /><col style={{ width: "8%" }} /><col style={{ width: "12%" }} />
        </colgroup>
        <thead className="border-b border-border">
          <tr>
            <th className="px-3 py-3 text-left text-[0.8125rem] font-semibold text-subtle-foreground">{t("favorites.cols.trader")}</th>
            {head("copyScore", t("favorites.cols.copyScore"))}
            {head("accountValue", t("favorites.cols.accountValue"))}
            {head("pnl", t("favorites.cols.totalPnl"))}
            {head("roi", t("favorites.cols.roi"))}
            {head("pnl30d", t("favorites.cols.pnl30d"))}
            {head("winRate", t("favorites.cols.winRate"))}
            {head("sharpe", t("favorites.cols.sharpe"))}
            {head("maxDrawdown", t("favorites.cols.mdd"))}
            <th className="px-3 py-3 text-center text-[0.8125rem] font-semibold whitespace-nowrap text-subtle-foreground">{t("favorites.cols.pnlChart")}</th>
            <th className="px-3 py-3" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.address} className="border-b border-border transition-colors last:border-0 hover:bg-raised/50">
              <td className="px-3 py-3"><TraderCell card={c} subtitle={<GroupTags address={c.address} groups={groups} className="mt-1.5" />} /></td>
              <td className="px-3 py-3"><CopyScoreBar score={c.copyScore} layout="bar-first" barClassName="w-10" className="justify-end" /></td>
              <td className="px-3 py-3 text-right">{plain(boardUsd(c.accountValue))}</td>
              <td className={cn("num px-3 py-3 text-right text-sm font-medium", signTone(c.pnl))}>{c.pnl === null ? "—" : format.usd(c.pnl, { compact: true, sign: true })}</td>
              <td className={cn("num px-3 py-3 text-right text-sm font-medium", signTone(c.roi))}>{boardRoi(c.roi)}</td>
              <td className={cn("num px-3 py-3 text-right text-sm font-medium", signTone(c.pnl30d))}>{c.pnl30d === null ? "—" : format.usd(c.pnl30d, { compact: true, sign: true })}</td>
              <td className="px-3 py-3 text-right">{plain(c.winRate === null ? "—" : format.pct(c.winRate, { digits: 1 }))}</td>
              <td className="px-3 py-3 text-right">{plain(c.sharpe === null ? "—" : c.sharpe.toFixed(2))}</td>
              <td className="px-3 py-3 text-right">{plain(c.maxDrawdown === null ? "—" : format.pct(c.maxDrawdown, { digits: 1 }))}</td>
              <td className="px-3 py-3"><BoardSparkline values={c.sparkline} height={34} className="mx-auto w-[76px]" /></td>
              <td className="px-3 py-3"><RowActions address={c.address} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phones: CopyDog's mobile card (avatar, name, PnL · ROI · score, actions). */
function MobileRow({ card, groups }: { card: TraderCard; groups: FavoriteGroup[] }) {
  const { t } = useI18n();
  return (
    <li className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <TraderCell
            card={card}
            size={40}
            subtitle={
              <>
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs whitespace-nowrap text-muted-foreground">
                  <span className={cn("num font-semibold", signTone(card.pnl))}>{card.pnl === null ? "—" : boardPnl(card.pnl)}</span>
                  <span className="num">{boardRoi(card.roi)} ROI</span>
                  {card.copyScore !== null ? <span className="num">{card.copyScore} {t("favorites.cols.copyScore")}</span> : null}
                </span>
                <GroupTags address={card.address} groups={groups} className="mt-1.5" />
              </>
            }
          />
        </div>
        <RowActions address={card.address} />
      </div>
    </li>
  );
}

/** 提醒: traders with an alert on (summary + in-place editor), then the
 * rest of the favorites, whose bell turns one on. */
function AlertsTab({ favorites }: { favorites: Favorite[] | undefined }) {
  const { t, format } = useI18n();
  const addresses = useMemo(() => (favorites ?? []).map((f) => f.address), [favorites]);
  const cards = useCards(addresses);
  const save = useSetFavoriteAlert();
  const byAddress = useMemo(() => new Map(cards.items.map((c) => [c.address, c])), [cards.items]);
  if (!favorites) return <div className="flex flex-col gap-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>;
  const on = favorites.filter((f) => f.alert.enabled);
  const off = favorites.filter((f) => !f.alert.enabled);
  const card = (f: Favorite): TraderCard => byAddress.get(f.address) ?? { address: f.address, displayName: f.stats?.displayName ?? null, avatarUrl: null, xHandle: null, verified: false, kol: false, accountValue: null, pnl: null, roi: null, copyScore: null, style: null, topCoins: [], lastTradeAt: null, sparkline: [], pnl30d: null, winRate: null, sharpe: null, maxDrawdown: null, source: "none" };
  const row = (f: Favorite, withDelete: boolean) => (
    <li key={f.address} className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <TraderCell card={card(f)} size={40} subtitle={<p className="mt-1 text-xs text-muted-foreground">{alertSummary(f.alert, t, format)}</p>} />
      </div>
      <AlertBell address={f.address} variant="pill" />
      {withDelete ? (
        <button
          type="button"
          onClick={() => save.mutate({ address: f.address, patch: { enabled: false } })}
          aria-label={t("favorites.alerts.delete")}
          title={t("favorites.alerts.delete")}
          className="inline-flex size-8 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-negative-soft hover:text-negative focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      {on.length === 0 ? (
        <EmptyState icon={Bell} title={t("favorites.alerts.empty")} className="rounded-2xl border border-border bg-card" />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">{on.map((f) => row(f, true))}</ul>
      )}
      {off.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("favorites.alerts.others")}</h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">{off.map((f) => row(f, false))}</ul>
        </section>
      ) : null}
    </div>
  );
}

/** Buy for an opening long / closing short, sell otherwise. */
export function isBuy(row: Pick<ActionFeedItem, "kind" | "side">): boolean {
  const long = row.side === "long" || row.side === "buy" || row.side === "B";
  return row.kind === "open" || row.kind === "add" || row.kind === "flip" ? long : !long;
}

/** 動態: "{name} 買入 {coin}，{value} @ {price}", newest first; rows that
 * just arrived over the stream flash. */
function FeedTab({ rows, loading, highlight, favorites, hasFavorites }: {
  rows: ActionFeedItem[];
  loading: boolean;
  highlight: ReadonlySet<string>;
  favorites: Favorite[];
  hasFavorites: boolean;
}) {
  const { t, format } = useI18n();
  const now = useNow();
  const names = useMemo(() => new Map(favorites.map((f) => [f.address, f.stats?.displayName ?? null])), [favorites]);
  const addresses = useMemo(() => [...new Set(rows.map((r) => r.address))].slice(0, 200), [rows]);
  const cards = useTraderCards(addresses);
  const cardNames = useMemo(() => new Map((cards.data?.items ?? []).map((c) => [c.address, c.displayName])), [cards.data]);
  if (loading) return <div className="flex flex-col gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (rows.length === 0) {
    return <EmptyState icon={Zap} title={hasFavorites ? t("favorites.feed.emptyWaiting") : t("favorites.feed.emptyNoAlerts")} className="rounded-2xl border border-border bg-card" />;
  }
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
      {rows.map((row) => {
        const id = String(row.id);
        const buy = isBuy(row);
        const name = cardNames.get(row.address) ?? names.get(row.address) ?? row.leaderLabel ?? truncateAddress(row.address);
        const price = Number(row.avgPx);
        return (
          <li key={id} className={cn(highlight.has(id) && "row-arrive")} data-live={highlight.has(id) ? "new" : undefined}>
            <Link href={`/trader/${row.address}`} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-raised/50 focus-visible:ring-2 focus-visible:ring-ring">
              <CoinIcon coin={row.coin} size={26} />
              <span className="min-w-0 flex-1 text-sm leading-relaxed">
                <em className="font-semibold not-italic">{name}</em>{" "}
                <em className={cn("font-semibold not-italic", buy ? "text-positive" : "text-negative")}>{buy ? t("favorites.feed.bought") : t("favorites.feed.sold")}</em>{" "}
                <em className="font-semibold not-italic">{coinLabel(row.coin)}</em>
                {"，"}
                <em className={cn("num font-semibold not-italic", buy ? "text-positive" : "text-negative")}>{format.usd(Math.abs(Number(row.notionalUsd)), { compact: true })}</em>
                {price > 0 ? (
                  <>
                    {" @ "}
                    <em className="num font-semibold not-italic">{format.price(price)}</em>
                  </>
                ) : null}
              </span>
              <time className="num shrink-0 text-xs text-subtle-foreground" dateTime={String(row.ts)}>{format.relative(row.ts, now)}</time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
