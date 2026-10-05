"use client";


import { Bitcoin, ChevronDown, ChevronRight, ListFilter, Trophy, UserRound, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { boardName, CoinStack, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { BoardCard, BoardCardSkeleton, BoardMobileRow, BoardMobileRowSkeleton } from "@/components/discover/board-card";
import { EmptyState, ErrorState, SkelBar, SkelCircle } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Select } from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import { boardCoinLabel, boardPnl, boardRoi, boardUsd } from "@/lib/board-format";
import type { BoardMarket, BoardSort, BoardTrader, BoardWindow, TradingStyle } from "@/lib/contracts";
import { useBoard, useSiteSettings } from "@/lib/queries";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useNow } from "@/lib/use-now";

const DEFAULT_CRYPTO = ["BTC", "ETH", "SOL", "DOGE", "HYPE", "ZEC", "NEAR"];
const DEFAULT_STOCKS = ["xyz:SP500", "xyz:GOLD", "xyz:CL", "xyz:NVDA", "xyz:TSLA", "xyz:BRENTOIL", "xyz:SILVER"];
const STYLES: Array<TradingStyle | "any"> = ["any", "scalp", "intraday", "swing", "position"];
const SORTS: BoardSort[] = ["copyScore", "pnl", "roi", "accountValue"];

type View = "auto" | "grid" | "list";

/** CopyDog's rules (its boardSorts chunk): coin boards and the stocks top
 * 100 have no window and no account-value sort; 30 天 sorts by PnL / ROI. */
function rules(market: BoardMarket, board: string, window: BoardWindow) {
  const coin = board !== "top100" && board !== "kol";
  const windowed = !coin && !(market === "stocks" && board === "top100");
  const effectiveWindow: BoardWindow = windowed ? window : "all";
  let sorts: BoardSort[] = windowed ? SORTS : ["copyScore", "pnl", "roi"];
  if (effectiveWindow === "30d") sorts = sorts.filter((s) => s === "pnl" || s === "roi");
  return { coin, windowed, effectiveWindow, sorts };
}

const pick = <T extends string>(value: string | null, options: readonly T[], fallback: T): T =>
  value !== null && (options as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * Explore (Stage 3 §1, CopyDog's /hyperliquid/discover): crypto / stocks,
 * board tabs (Top 100, KOL, coins), style, sort, window and grid / list;
 * a fixed top 100 from the api's discovery pool.
 */
export function BoardsView() {
  const { t } = useI18n();
  const params = useSearchParams();
  const settings = useSiteSettings();
  const cryptoBoards = settings.data?.cryptoBoards ?? DEFAULT_CRYPTO;
  const stockBoards = settings.data?.stockBoards ?? DEFAULT_STOCKS;

  const initialMarket = pick(params.get("market"), ["crypto", "stocks"] as const, params.get("board")?.includes(":") ? "stocks" : "crypto");
  const [market, setMarket] = useState<BoardMarket>(initialMarket);
  const [board, setBoard] = useState(params.get("board") ?? "top100");
  const [sort, setSort] = useState<BoardSort>(pick(params.get("sort"), SORTS, "copyScore"));
  const [window, setWindow] = useState<BoardWindow>(pick(params.get("window"), ["30d", "all"] as const, "all"));
  const [style, setStyle] = useState<TradingStyle | "any">(pick(params.get("style"), STYLES, "any"));
  // "auto": grid on desktop, CopyDog's dense list on phones.
  const [view, setView] = useState<View>(pick(params.get("view"), ["auto", "grid", "list"] as const, "auto"));
  const [sheet, setSheet] = useState(false);
  const desktop = useIsDesktop();

  const r = rules(market, board, window);
  const effectiveSort: BoardSort = r.sorts.includes(sort) ? sort : "pnl";

  // Shareable state: the URL follows the controls without a navigation.
  useEffect(() => {
    // Only replace board filters. Privy consumes its OAuth callback parameters
    // after initialization; clearing them here can leave Google users signed out.
    const qs = new URLSearchParams(globalThis.location.search);
    for (const key of ["market", "board", "sort", "window", "style", "view"]) qs.delete(key);
    if (market !== "crypto") qs.set("market", market);
    if (board !== "top100") qs.set("board", board);
    if (effectiveSort !== "copyScore") qs.set("sort", effectiveSort);
    if (r.effectiveWindow !== "all") qs.set("window", r.effectiveWindow);
    if (style !== "any") qs.set("style", style);
    if (view !== "auto") qs.set("view", view);
    const next = `${globalThis.location.pathname}${qs.size ? `?${qs}` : ""}`;
    if (next !== `${globalThis.location.pathname}${globalThis.location.search}`) globalThis.history.replaceState(null, "", next);
  }, [market, board, effectiveSort, r.effectiveWindow, style, view]);

  const query = useBoard({ market, board, sort: effectiveSort, window: r.effectiveWindow, style: style === "any" ? undefined : style });
  const data = query.data;
  const items = data?.items ?? [];
  const stocksTop = market === "stocks" && board === "top100";
  // CopyDog labels the stocks top 100 with its scope, "Stocks", in every locale.
  const scope = r.coin ? boardCoinLabel(board, t) : stocksTop ? "Stocks" : null;
  const pnlLabel = scope ? t("discover.coinPnl", { coin: scope }) : t("discover.pnl");
  const roiLabel = scope ? t("discover.coinRoi", { coin: scope }) : t("discover.roi");
  const roiHint = r.coin && scope ? t("discover.coinRoiHint", { coin: scope }) : stocksTop ? t("discover.stocksHint") : undefined;
  const now = useNow();

  const tabs = useMemo(() => {
    const coins = market === "crypto" ? cryptoBoards : stockBoards;
    return [
      { key: "top100", label: t("discover.top100"), icon: <Trophy className="size-[18px] fill-current" aria-hidden /> },
      ...(market === "crypto" ? [{ key: "kol", label: t("discover.kol"), icon: <UserRound className="size-[18px] fill-current" aria-hidden /> }] : []),
      ...coins.map((coin) => ({ key: coin, label: boardCoinLabel(coin, t), icon: <CoinIcon coin={coin} size={16} /> })),
    ];
  }, [market, cryptoBoards, stockBoards, t]);

  function switchMarket(next: BoardMarket) {
    if (next === market) return;
    setMarket(next);
    setBoard("top100");
    if (next === "stocks") setSort("pnl");
  }
  function switchBoard(next: string) {
    // CopyDog: entering a coin board from Top 100 / KOL resets to PnL.
    if (next !== "top100" && next !== "kol" && (board === "top100" || board === "kol")) setSort("pnl");
    setBoard(next);
  }

  const sortLabel = (s: BoardSort) => t(`discover.sort.${s}`);

  return (
    <div className="flex flex-col gap-4">
      {/* Phones: title, filter sheet and layout toggle (M-Explore). */}
      <div className="flex items-center justify-between md:hidden">
        <p role="heading" aria-level={1} className="font-display text-[2rem] leading-tight">{t("discover.title")}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSheet(true)}
            aria-label={t("discover.filters")}
            className="orbit-press flex size-11 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ListFilter className="size-[18px]" strokeWidth={2.4} />
          </button>
          <ViewToggle value={view === "grid" ? "grid" : "list"} onChange={setView} listFirst />
        </div>
      </div>

      {/* CopyDog's .hl-hero: a 42px row, 20px above the board chips. */}
      <div className="flex flex-wrap items-center justify-between gap-3 md:gap-4">
        <div className="flex w-full items-center gap-4 md:w-auto">
          {/* The desktop title (C-Explore): Fredoka 40 beside the asset switch. */}
          <h1 className="type-h1 hidden md:block">{t("discover.title")}</h1>
          <AssetSwitch value={market} onChange={switchMarket} />
        </div>
        <div className="hidden flex-wrap items-center gap-2.5 md:flex">
          <PillMenu
            name={t("discover.styleLabel")}
            label={style === "any" ? t("discover.styleLabel") : STYLE_MENU[style]}
            active={style !== "any"}
            value={style}
            options={STYLES.map((s) => ({ value: s, label: STYLE_MENU[s] }))}
            onChange={(v) => setStyle(v as TradingStyle | "any")}
          />
          <PillMenu
            name={t("discover.sortLabel")}
            label={sortLabel(effectiveSort)}
            value={effectiveSort}
            options={r.sorts.map((s) => ({ value: s, label: sortLabel(s) }))}
            onChange={(v) => setSort(v as BoardSort)}
            strong
          />
          {r.windowed ? (
            <div className="seg-track" role="group" aria-label={t("discover.timeframe")}>
              {(["30d", "all"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={r.effectiveWindow === w}
                  onClick={() => setWindow(w)}
                  className={cn(
                    "seg-item outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
                    r.effectiveWindow === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`discover.window.${w}`)}
                </button>
              ))}
            </div>
          ) : null}
          <ViewToggle value={view === "list" ? "list" : "grid"} onChange={setView} />
        </div>
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 no-scrollbar md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label={t("discover.boards")}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={board === tab.key}
            onClick={() => switchBoard(tab.key)}
            className={cn(
              "orbit-press flex h-11 shrink-0 items-center gap-2 rounded-full border-2 px-[18px] text-sm leading-none whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              board === tab.key ? "border-primary bg-primary font-extrabold text-primary-foreground" : "border-input font-bold text-muted-foreground hover:bg-raised hover:text-foreground",
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {query.isError && !data ? (
        <ErrorState message={t("discover.error")} onRetry={() => query.refetch()} />
      ) : !data ? (
        <BoardSkeleton view={view} />
      ) : items.length === 0 ? (
        <EmptyState
          title={board === "kol" ? t("discover.kolEmpty") : t("discover.empty")}
          body={board === "kol" ? t("discover.kolEmptyHint") : t("discover.emptyHint")}
        />
      ) : (
        <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")} aria-busy={query.isFetching}>
          {/* One layout per trader, not two with one hidden: "auto" is the
              cards on desktop and the rows on a phone; the list view is the
              rows on a phone and the table on desktop. (Until the width is
              known — never with data in practice — CSS picks, as before.) */}
          {view === "grid" || (view === "auto" && desktop !== false) ? (
            <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", view === "auto" && "hidden md:grid")}>
              {items.map((trader) => (
                <BoardCard key={trader.address} trader={trader} pnlLabel={pnlLabel} roiLabel={roiLabel} roiHint={roiHint} now={now} />
              ))}
            </div>
          ) : null}
          {view !== "grid" && desktop !== true ? (
            <ul className="flex flex-col gap-2 md:hidden">
              {items.map((trader) => (
                <BoardMobileRow key={trader.address} trader={trader} />
              ))}
            </ul>
          ) : null}
          {view === "list" && desktop !== false ? (
            <BoardTable
              items={items}
              sorts={r.sorts}
              sort={effectiveSort}
              onSort={setSort}
              pnlLabel={pnlLabel}
              roiLabel={roiLabel}
              roiHint={roiHint}
            />
          ) : null}
        </div>
      )}

      {sheet ? (
        <FilterSheet
          sorts={r.sorts}
          windowed={r.windowed}
          sort={effectiveSort}
          window={r.effectiveWindow}
          style={style}
          onClose={() => setSheet(false)}
          onApply={(next) => {
            setSort(next.sort);
            setWindow(next.window);
            setStyle(next.style);
            setSheet(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** CopyDog's toolbar icons are solid shapes, not outlines: a coin disc with
 * the ₿ cut out of it, two filled candles, four tiles and three bars. */
function CoinGlyph({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="flex size-[18px] items-center justify-center rounded-full bg-current">
      <Bitcoin className={cn("size-3", active ? "text-primary-text" : "text-raised")} strokeWidth={3} />
    </span>
  );
}
function CandlesGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="size-[18px] fill-current">
      <rect x="2.5" y="5" width="5" height="8" rx="1" />
      <rect x="4.25" y="2" width="1.5" height="14" rx="0.75" />
      <rect x="10.5" y="7" width="5" height="6" rx="1" />
      <rect x="12.25" y="4" width="1.5" height="12" rx="0.75" />
    </svg>
  );
}
function GridGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 fill-current">
      <rect x="2" y="2" width="5.3" height="5.3" rx="1" />
      <rect x="8.7" y="2" width="5.3" height="5.3" rx="1" />
      <rect x="2" y="8.7" width="5.3" height="5.3" rx="1" />
      <rect x="8.7" y="8.7" width="5.3" height="5.3" rx="1" />
    </svg>
  );
}
function BarsGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 17 17" className="size-[17px] fill-current">
      <rect x="2" y="3" width="13" height="1.5" />
      <rect x="2" y="7.75" width="13" height="1.5" />
      <rect x="2" y="12.5" width="13" height="1.5" />
    </svg>
  );
}

function AssetSwitch({ value, onChange }: { value: BoardMarket; onChange: (v: BoardMarket) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid w-full grid-cols-2 gap-0.5 rounded-[26px] bg-raised p-1 md:inline-grid md:w-auto" role="tablist" aria-label={t("discover.assetClass")}>
      {(["crypto", "stocks"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "seg-item outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring md:min-w-[108px]",
            value === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "crypto" ? <CoinGlyph active={value === m} /> : <CandlesGlyph />}
          {t(`discover.${m}`)}
        </button>
      ))}
    </div>
  );
}

export function ViewToggle({ value, onChange, listFirst = false }: {
  value: "grid" | "list";
  onChange: (v: "grid" | "list") => void;
  /** CopyDog's phone switch puts the list first. */
  listFirst?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5 rounded-[26px] bg-raised p-1" role="group" aria-label={t("discover.layout")}>
      {(listFirst ? (["list", "grid"] as const) : (["grid", "list"] as const)).map((v) => {
        const Icon = v === "grid" ? GridGlyph : BarsGlyph;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            aria-label={t(`discover.${v}`)}
            onClick={() => onChange(v)}
            className={cn(
              "flex size-11 items-center justify-center rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

function PillMenu({ name, label, value, options, onChange, active = false, strong = false }: {
  /** The filter's accessible name ("Style", "Sort"); `label` is what the pill shows. */
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  active?: boolean;
  strong?: boolean;
}) {
  // The board's filter pills: the shared select at the toolbar size, the
  // pill naming the filter and the list checking the current choice.
  return (
    <Select
      size="sm"
      label={name}
      display={label}
      value={value}
      onValueChange={onChange}
      options={options}
      className={cn("w-auto", strong || active ? "text-foreground" : "text-muted-foreground")}
    />
  );
}

/** CopyDog's desktop Style menu is in English in every language (its phone
 * filter sheet translates the same choices). */
const STYLE_MENU: Record<TradingStyle | "any", string> = { any: "All styles", scalp: "Scalp", intraday: "Intraday", swing: "Swing", position: "Position" };

/** Desktop list (CopyDog's table): trader, copy score, assets, PnL, ROI,
 * equity; sortable where the board allows. */
function BoardTable({ items, sorts, sort, onSort, pnlLabel, roiLabel, roiHint }: {
  items: BoardTrader[];
  sorts: BoardSort[];
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  pnlLabel: string;
  roiLabel: string;
  roiHint?: string;
}) {
  const { t } = useI18n();
  const head = (key: BoardSort, label: string, align: "left" | "right", title?: string) => {
    const sortable = sorts.includes(key);
    return (
      <th className={cn("px-3 pt-1 text-xs font-bold text-muted-foreground", align === "right" ? "text-right" : "text-left")} aria-sort={sort === key ? "descending" : undefined} title={title}>
        {sortable ? (
          <button
            type="button"
            onClick={() => onSort(key)}
            className={cn("inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", sort === key && "font-extrabold text-foreground")}
          >
            {label}
            {sort === key ? <ChevronDown className="size-3" /> : null}
          </button>
        ) : (
          label
        )}
      </th>
    );
  };
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[860px] border-separate border-spacing-y-2 text-sm font-bold">
        <thead>
          <tr>
            <th className="px-3 pt-1 pl-[18px] text-left text-xs font-bold text-muted-foreground">{t("discover.trader")}</th>
            {head("copyScore", t("discover.copyScore"), "left")}
            <th className="px-3 pt-1 text-left text-xs font-bold text-muted-foreground">{t("discover.assets")}</th>
            {head("pnl", pnlLabel, "right")}
            {head("roi", roiLabel, "right", roiHint)}
            {head("accountValue", t("discover.equity"), "right")}
          </tr>
        </thead>
        <tbody className="data-rows">
          {items.map((trader) => (
            <tr key={trader.address}>
              <td className="h-16 px-3 pl-[18px]">
                <Link href={`/trader/${trader.address}`} className="flex min-w-0 items-center gap-2.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <TraderAvatar trader={trader} size={36} />
                  <span className="truncate font-extrabold">{boardName(trader)}</span>
                  {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
                  {trader.xHandle ? (
                    <span className="text-xs text-subtle-foreground" title={`@${trader.xHandle}`} aria-label={`X @${trader.xHandle}`}>𝕏</span>
                  ) : null}
                </Link>
              </td>
              <td className="px-3">
                <CopyScoreBar score={trader.copyScore} layout="number-first" barClassName="w-28 bg-card" />
              </td>
              <td className="px-3">
                <CoinStack coins={trader.topCoins} size={18} dash />
              </td>
              <td className={cn("num px-3 text-right font-display text-[15px]", signTone(trader.pnl))}>{boardPnl(trader.pnl)}</td>
              <td className={cn("num px-3 text-right font-display text-[15px]", signTone(trader.roi))}>{boardRoi(trader.roi)}</td>
              <td className="num px-3 pr-[18px] text-right font-display text-[15px]">{boardUsd(trader.accountValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoardSkeleton({ view }: { view: View }) {
  const { t } = useI18n();
  return (
    <>
      {view !== "list" ? (
        <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", view === "auto" && "hidden md:grid")}>
          {Array.from({ length: 8 }, (_, i) => <BoardCardSkeleton key={i} />)}
        </div>
      ) : (
        // BoardTable's header over its 64px raised rows.
        <div aria-hidden="true" className="ui-skeleton hidden overflow-hidden md:block [--skel-bar:var(--border)]">
          <table className="w-full min-w-[860px] border-separate border-spacing-y-2 text-sm font-bold">
            <thead>
              <tr>
                {([["discover.trader", "left"], ["discover.copyScore", "left"], ["discover.assets", "left"], ["discover.pnl", "right"], ["discover.roi", "right"], ["discover.equity", "right"]] as const).map(([key, align], i) => (
                  <th key={key} className={cn("px-3 pt-1 text-xs font-bold text-muted-foreground", align === "right" ? "text-right" : "text-left", i === 0 && "pl-[18px]")}>{t(key)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="data-rows">
              {Array.from({ length: 10 }, (_, r) => (
                <tr key={r}>
                  <td className="h-16 px-3 pl-[18px]">
                    <span className="flex items-center gap-2.5">
                      <SkelCircle className="size-9" />
                      <SkelBar className="h-3.5 w-28" />
                    </span>
                  </td>
                  <td className="px-3"><SkelBar className="h-2.5 w-36" /></td>
                  <td className="px-3"><SkelBar className="h-[18px] w-12" /></td>
                  <td className="px-3"><SkelBar className="ml-auto h-3 w-20" /></td>
                  <td className="px-3"><SkelBar className="ml-auto h-3 w-14" /></td>
                  <td className="px-3 pr-[18px]"><SkelBar className="ml-auto h-3 w-24" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view !== "grid" ? (
        <ul className="flex flex-col gap-2 md:hidden">
          {Array.from({ length: 8 }, (_, i) => <BoardMobileRowSkeleton key={i} />)}
        </ul>
      ) : null}
    </>
  );
}

/** Phones: CopyDog's 所有篩選 bottom sheet (sort, timeframe, style; reset
 * and apply). */
function FilterSheet({ sorts, windowed, sort, window, style, onClose, onApply }: {
  sorts: BoardSort[];
  windowed: boolean;
  sort: BoardSort;
  window: BoardWindow;
  style: TradingStyle | "any";
  onClose: () => void;
  onApply: (next: { sort: BoardSort; window: BoardWindow; style: TradingStyle | "any" }) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ sort, window, style });
  const [open, setOpen] = useState<"sort" | "window" | "style" | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows: Array<{ key: "sort" | "window" | "style"; label: string; value: string; options: Array<{ value: string; label: string }> }> = [
    { key: "sort", label: t("discover.sortBy"), value: draft.sort, options: sorts.map((s) => ({ value: s, label: t(`discover.sort.${s}`) })) },
    ...(windowed
      ? [{ key: "window" as const, label: t("discover.timeframe"), value: draft.window, options: (["30d", "all"] as const).map((w) => ({ value: w, label: t(`discover.window.${w}`) })) }]
      : []),
    { key: "style", label: t("discover.styles"), value: draft.style, options: STYLES.map((s) => ({ value: s, label: t(`discover.style.${s}`) })) },
  ];
  const focusRef = useModalFocus<HTMLDivElement>(true, onClose);
  return (
    <div ref={focusRef} className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={t("discover.filters")}>
      <button type="button" aria-label={t("discover.close")} className="absolute inset-0 bg-overlay animate-in fade-in-0 motion-reduce:animate-none" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[32px] bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_0_0_2px_var(--card-ring)] animate-in slide-in-from-bottom duration-300 motion-reduce:animate-none">
        <span className="mx-auto mt-2.5 h-1.5 w-12 rounded-full bg-border" aria-hidden />
        <div className="flex items-center justify-between px-5 pt-3 pb-2">
          <h2 className="type-h2">{t("discover.filters")}</h2>
          <button type="button" onClick={onClose} aria-label={t("discover.close")} className="orbit-press flex size-11 items-center justify-center rounded-full bg-inset outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-5" strokeWidth={2.4} />
          </button>
        </div>
        <div className="overflow-y-auto px-5">
          {rows.map((row) => (
            <div key={row.key} className="border-b-2 border-dotted border-border">
              <button
                type="button"
                aria-expanded={open === row.key}
                onClick={() => setOpen(open === row.key ? null : row.key)}
                className="flex w-full items-center justify-between py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="block font-extrabold">{row.label}</span>
                  <span className="mt-0.5 block text-sm font-bold text-muted-foreground">{row.options.find((o) => o.value === row.value)?.label}</span>
                </span>
                <ChevronRight className={cn("size-4 text-subtle-foreground transition-transform", open === row.key && "rotate-90")} />
              </button>
              {open === row.key ? (
                <div className="flex flex-wrap gap-2 pb-4">
                  {row.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={row.value === o.value}
                      onClick={() => setDraft((d) => ({ ...d, [row.key]: o.value }))}
                      className={cn(
                        "orbit-press h-11 rounded-full px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        row.value === o.value ? "bg-primary font-extrabold text-primary-foreground" : "bg-inset font-bold text-muted-foreground",
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 px-5 py-4">
          <button
            type="button"
            onClick={() => setDraft({ sort: "copyScore", window: "all", style: "any" })}
            className="orbit-press h-[52px] rounded-full bg-inset font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("discover.reset")}
          </button>
          <button
            type="button"
            onClick={() => onApply({ ...draft, sort: sorts.includes(draft.sort) ? draft.sort : "pnl" })}
            className="orbit-press h-[52px] rounded-full bg-primary font-extrabold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("discover.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
