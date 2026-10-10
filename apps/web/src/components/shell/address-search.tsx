"use client";

import { ChevronLeft, Search, X } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";

import { TraderAvatar } from "@/components/discover/board-bits";
import { useT } from "@/i18n/provider";
import type { DiscoverSearchResponse } from "@/lib/contracts";
import { truncateAddress, usdCompact } from "@/lib/format";
import { useDiscoverSearch } from "@/lib/queries";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { useModalFocus } from "@/lib/use-modal-focus";
import { SkelBar, SkelCircle } from "@/components/page";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Keystrokes settle this long before a search request goes out. */
const DEBOUNCE_MS = 200;

type Result = DiscoverSearchResponse["items"][number];

/** CopyDog keeps the last five picks per platform and lists them on an
 * empty focus ("最近搜尋 · 清除", each with its own ×). */
const RECENT_KEY = "orbie:recent-searches:hyperliquid";
const RECENT_MAX = 5;
type Recent = Pick<Result, "address" | "displayName" | "avatarUrl" | "pnl" | "roi">;

function readRecent(): Recent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.address === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecent(rows: Recent[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(rows.slice(0, RECENT_MAX)));
  } catch {
    // Private mode: recents just aren't kept.
  }
}

/** CopyDog's dropdown ROI: whole percent from 100% up ("+1,486%"), one
 * decimal below ("-60.2%", "+0.0%"). */
function searchRoi(ratio: number): string {
  const pct = ratio * 100;
  const sign = pct >= 0 ? "+" : "-";
  const a = Math.abs(pct);
  return `${sign}${a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1)}%`;
}

/** The name with the typed text lit, as CopyDog's dropdown shows it. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().replace(/^@/, "");
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-extrabold text-primary-text">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The top bar's search, as on CopyDog: typing a name (KOL name, 𝕏 handle,
 * leaderboard name) or an address prefix opens a dropdown of up to five
 * traders (avatar, name with the match lit, short address, all-time PnL and
 * ROI); nothing opens on an empty focus. ↑/↓ move, Enter opens the
 * highlighted trader, or with none highlighted the trader page for the
 * typed text (the 404 when there is no such trader), Esc closes. On a phone
 * the search takes the whole screen while open (back arrow, field, then
 * name + full address rows), as CopyDog's app-style search does.
 */
export function AddressSearch({ compact = false, buttonClassName }: {
  /** Phones: only CopyDog's search icon until it's tapped. */
  compact?: boolean;
  buttonClassName?: string;
} = {}) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  // CopyDog lights no row until ↑/↓ or the pointer picks one.
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<Recent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const query = useDebounced(value.trim(), DEBOUNCE_MS);
  const search = useDiscoverSearch(query);
  // The long placeholder doesn't fit a phone's top bar.
  const wide = useIsDesktop();
  // The phone search covers the screen: focus stays in it while it is open.
  const rootRef = useModalFocus<HTMLFormElement>(wide === false && open, () => {
    setOpen(false);
    inputRef.current?.blur();
  });

  const trimmed = value.trim();
  const results: Result[] = trimmed && search.data ? search.data.items : [];
  const fullAddress = ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
  // A full address the search doesn't know still opens its page.
  const rows: Array<Result | { address: string; direct: true }> =
    fullAddress && !results.some((r) => r.address === fullAddress) ? [{ address: fullAddress, direct: true }, ...results] : results;
  const settled = query === trimmed && !search.isFetching;
  const showRecent = open && trimmed.length === 0 && recent.length > 0;
  const showList = (open && trimmed.length > 0 && (rows.length > 0 || (settled && search.isSuccess))) || showRecent;
  const listRows: Array<Result | Recent | { address: string; direct: true }> = showRecent ? recent : rows;
  // Typed, and the first answer is still out: the list's rows as skeletons.
  const searching = open && trimmed.length > 0 && !showList && !search.isError && !(settled && !search.isPending);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, rootRef]);

  function remember(row: Result | Recent | { address: string; direct: true } | undefined, address: string) {
    const entry: Recent = row && !("direct" in row)
      ? { address: row.address, displayName: row.displayName, avatarUrl: row.avatarUrl, pnl: row.pnl, roi: row.roi }
      : { address: address.toLowerCase(), displayName: null, avatarUrl: null, pnl: null, roi: null };
    const next = [entry, ...readRecent().filter((r) => r.address !== entry.address)];
    writeRecent(next);
    setRecent(next.slice(0, RECENT_MAX));
  }

  function forget(address?: string) {
    const next = address ? readRecent().filter((r) => r.address !== address) : [];
    writeRecent(next);
    setRecent(next);
  }

  function go(address: string, row?: Result | Recent | { address: string; direct: true }) {
    remember(row, address);
    setValue("");
    setOpen(false);
    inputRef.current?.blur();
    router.push(`/trader/${address.toLowerCase()}`);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    // CopyDog: Enter opens the row ↑/↓ lit; with none lit it opens the
    // trader page for the typed text as it stands (a page that finds no
    // trader is the 404).
    // …but only a row of the list for what is typed now: while the search
    // for the latest keystrokes is still out, the rows on screen answer an
    // earlier query, and Enter must not open one of those.
    const current = showRecent || settled || (active === 0 && listRows[0] && "direct" in listRows[0]);
    const pick = showList && active >= 0 && current ? listRows[active] : undefined;
    if (pick) return go(pick.address, pick);
    if (ADDRESS.test(q)) return go(q);
    setValue("");
    setOpen(false);
    inputRef.current?.blur();
    router.push(`/trader/${encodeURIComponent(q)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showList || listRows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % listRows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? listRows.length - 1 : i - 1));
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;
  // Phones: a full-screen search while it's open.
  const overlay = wide === false && open;
  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };
  // …and focus returns to the search button (which the overlay replaced)
  // when it closes.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOverlay = useRef(false);
  useEffect(() => {
    if (wasOverlay.current && !overlay) buttonRef.current?.focus({ preventScroll: true });
    wasOverlay.current = overlay;
  }, [overlay]);

  if (compact && !overlay) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("topbar.searchLabel")}
        disabled={wide === undefined}
        onClick={() => setOpen(true)}
        className={cn("orbit-press flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring", buttonClassName)}
      >
        <Search className="size-[18px]" strokeWidth={2.4} />
      </button>
    );
  }

  return (
    <form
      ref={rootRef}
      role="search"
      onSubmit={submit}
      className={overlay ? "fixed inset-0 z-[60] flex flex-col bg-background pt-[env(safe-area-inset-top)] animate-in fade-in-0 motion-reduce:animate-none" : "relative w-full max-w-[400px]"}
    >
      <div className={cn("flex items-center", overlay ? "gap-2 px-3 pt-2 pb-3" : "gap-1.5")}>
      {overlay ? (
        <button
          type="button"
          aria-label={t("settings.back")}
          onClick={close}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-5" strokeWidth={2.4} />
        </button>
      ) : null}
      <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        strokeWidth={2.4}
        className={cn("pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-subtle-foreground", !overlay && "md:left-5")}
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 && active < listRows.length ? optionId(active) : undefined}
        maxLength={64}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setRecent(readRecent());
          setOpen(true);
        }}
        autoFocus={compact}
        onKeyDown={onKeyDown}
        placeholder={wide === false ? t("topbar.searchShort") : t("topbar.search")}
        aria-label={t("topbar.searchLabel")}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "w-full text-ellipsis rounded-full border-2 border-transparent bg-raised pr-11 font-bold text-foreground outline-none transition-colors placeholder:font-bold placeholder:text-subtle-foreground hover:bg-raised-hover focus-visible:border-primary",
          overlay ? "h-12 pl-11 text-[15px]" : "h-11 pl-11 text-sm md:h-[52px] md:pl-[46px]",
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label={t("topbar.searchClear")}
          onClick={() => {
            setValue("");
                    inputRef.current?.focus();
          }}
          className="absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : null}
      </div>
      </div>
      {overlay && !showList && trimmed.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">{t("topbar.searchHint")}</p>
      ) : null}
      {searching ? (
        <div
          role="status"
          aria-label={t("common.loading")}
          className={
            overlay
              ? "min-h-0 flex-1 overflow-hidden pb-6"
              : "absolute inset-x-0 top-[calc(100%+10px)] z-50 overflow-hidden rounded-2xl bg-popover p-2 shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)]"
          }
        >
          <div aria-hidden="true" className="ui-skeleton">
            {[0, 1, 2].map((i) =>
              overlay ? (
                <div key={i} className="flex min-h-16 flex-col justify-center gap-1.5 px-5 py-3">
                  <SkelBar className="h-3.5 w-32" />
                  <SkelBar className="h-2.5 w-56 max-w-full" />
                </div>
              ) : (
                <div key={i} className="flex min-h-14 items-center gap-3 px-3 py-2.5">
                  <SkelCircle className="size-[34px]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <SkelBar className="h-3 w-28" />
                    <SkelBar className="h-2 w-20" />
                  </span>
                  <span className="flex flex-col items-end gap-1.5">
                    <SkelBar className="h-3 w-14" />
                    <SkelBar className="h-2 w-10" />
                  </span>
                </div>
              ),
            )}
          </div>
        </div>
      ) : null}
      {showList ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("topbar.searchResults")}
          className={
            overlay
              ? "min-h-0 flex-1 overflow-y-auto pb-6"
              : "absolute inset-x-0 top-[calc(100%+10px)] z-50 max-h-[440px] overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-2 shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
          }
        >
          {showRecent ? (
            <div className={cn("flex items-center justify-between text-xs font-bold text-muted-foreground", overlay ? "px-5 py-2 [&>button]:text-primary-text" : "px-3 pt-2 pb-1.5")}>
              <span>{t("topbar.searchRecent")}</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => forget()}
                className="rounded text-xs font-extrabold outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("topbar.searchClearRecent")}
              </button>
            </div>
          ) : null}
          {listRows.length === 0 && overlay ? (
            // CopyDog's phone search: one plain line under the field.
            <p className="px-5 py-4 text-sm text-muted-foreground">{t("topbar.searchEmpty")}</p>
          ) : listRows.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-7 text-center text-[13.5px] text-muted-foreground">
              <span>{t("topbar.searchEmpty")}</span>
              <span className="text-[11.5px] opacity-75">{t("topbar.searchHint")}</span>
            </div>
          ) : (
            listRows.map((row, i) => {
              const direct = "direct" in row;
              const name = direct ? null : row.displayName?.trim() || null;
              if (overlay) {
                // CopyDog's phone list: the name, then the whole address.
                return (
                  <div
                    key={row.address}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(row.address, row);
                    }}
                    className="flex min-h-16 cursor-pointer flex-col justify-center gap-0.5 px-5 py-3 active:bg-raised"
                  >
                    <p className="max-w-full truncate text-base font-semibold">
                      {direct ? t("topbar.searchOpenAddress") : name ?? truncateAddress(row.address)}
                    </p>
                    <p className="max-w-full truncate text-xs text-muted-foreground">{row.address}</p>
                  </div>
                );
              }
              const q = showRecent ? "" : trimmed;
              return (
                <div
                  key={row.address}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  onPointerEnter={() => setActive(i)}
                  // mousedown, not click: the input's blur must not close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(row.address, row);
                  }}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-[background-color]",
                    i === active && "bg-raised",
                  )}
                >
                  <TraderAvatar trader={{ address: row.address, avatarUrl: direct ? null : row.avatarUrl }} size={34} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {direct ? (
                      <span className="truncate text-[13.5px] leading-[1.25] font-semibold">{t("topbar.searchOpenAddress")}</span>
                    ) : name ? (
                      <>
                        <span className="truncate text-[13.5px] leading-[1.25] font-semibold"><Highlighted text={name} query={q} /></span>
                        <span className="truncate font-mono text-[11px] leading-[1.2] text-muted-foreground">{truncateAddress(row.address)}</span>
                      </>
                    ) : (
                      <span className="truncate font-mono text-[13px] leading-[1.25] font-semibold"><Highlighted text={truncateAddress(row.address)} query={q} /></span>
                    )}
                  </div>
                  {!direct && row.pnl !== null ? (
                    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                      <span className={cn("num text-[13px] leading-[1.25] font-semibold", row.pnl >= 0 ? "text-positive" : "text-negative")}>
                        {usdCompact(row.pnl, { sign: true })}
                      </span>
                      {row.roi !== null ? (
                        <span className="num flex items-baseline gap-[5px] text-[11px] leading-[1.2] text-muted-foreground">
                          <span className="text-[10px] font-extrabold">ROI</span>
                          {searchRoi(row.roi)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {showRecent ? (
                    <button
                      type="button"
                      aria-label={t("topbar.searchRemoveRecent")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        forget(row.address);
                      }}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-2.5" strokeWidth={2} />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </form>
  );
}
