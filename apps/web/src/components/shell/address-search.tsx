"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "cn";

import { TraderAvatar } from "@/components/discover/board-bits";
import { useT } from "@/i18n/provider";
import type { TraderSearchResponse } from "@/lib/contracts";
import { truncateAddress, usdCompact } from "@/lib/format";
import { useTraderSearch } from "@/lib/queries";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Keystrokes settle this long before a search request goes out. */
const DEBOUNCE_MS = 200;

type Result = TraderSearchResponse["items"][number];

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
      <span className="text-primary">{text.slice(i, i + q.length)}</span>
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
 * highlighted trader (a full 0x address opens directly; any other text with
 * no match goes to the full leaderboard's search), Esc closes.
 */
export function AddressSearch() {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const listId = useId();
  const query = useDebounced(value.trim(), DEBOUNCE_MS);
  const search = useTraderSearch(query);
  // The long placeholder doesn't fit a phone's top bar.
  const wide = useSyncExternalStore<boolean | undefined>(
    (onChange) => {
      const mq = window.matchMedia("(min-width: 768px)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(min-width: 768px)").matches,
    () => undefined,
  );

  const trimmed = value.trim();
  const results: Result[] = trimmed && search.data ? search.data.items : [];
  const fullAddress = ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
  // A full address the search doesn't know still opens its page.
  const rows: Array<Result | { address: string; direct: true }> =
    fullAddress && !results.some((r) => r.address === fullAddress) ? [{ address: fullAddress, direct: true }, ...results] : results;
  const settled = query === trimmed && !search.isFetching;
  const showList = open && trimmed.length > 0 && (rows.length > 0 || (settled && search.isSuccess));

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function go(address: string) {
    setValue("");
    setOpen(false);
    setInvalid(false);
    inputRef.current?.blur();
    router.push(`/trader/${address.toLowerCase()}`);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    const pick = rows[Math.min(active, rows.length - 1)];
    if (showList && pick) return go(pick.address);
    if (ADDRESS.test(q)) return go(q);
    if (/^0x[0-9a-fA-F]*$/.test(q) && q.length > 42) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setOpen(false);
    router.push(`/explore/all?q=${encodeURIComponent(q)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showList || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + rows.length) % rows.length);
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <form ref={rootRef} role="search" onSubmit={submit} className="relative w-full max-w-[460px]">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && rows.length > 0 ? optionId(Math.min(active, rows.length - 1)) : undefined}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(0);
          if (invalid) setInvalid(false);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={wide === false ? t("topbar.searchShort") : t("topbar.search")}
        aria-label={t("topbar.searchLabel")}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "h-11 w-full rounded-full border border-transparent bg-raised pr-11 pl-11 text-sm text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:bg-raised-hover focus-visible:border-primary/50 focus-visible:bg-raised-hover md:h-12 md:text-[0.9375rem]",
          invalid && "border-negative/60",
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label={t("topbar.searchClear")}
          onClick={() => {
            setValue("");
            setInvalid(false);
            inputRef.current?.focus();
          }}
          className="absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : null}
      {invalid ? (
        <p
          id={hintId}
          role="alert"
          className="absolute top-full left-4 mt-1.5 rounded-lg bg-popover px-2.5 py-1 text-xs text-negative shadow-lg"
        >
          {t("topbar.invalidAddress")}
        </p>
      ) : null}
      {showList ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("topbar.searchResults")}
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-border bg-popover py-1.5 shadow-2xl"
        >
          {rows.length === 0 ? (
            <div className="px-4 py-3">
              <p className="text-sm font-semibold">{t("topbar.searchEmpty")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("topbar.searchHint")}</p>
            </div>
          ) : (
            rows.map((row, i) => {
              const direct = "direct" in row;
              const name = direct ? null : row.displayName?.trim() || null;
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
                    go(row.address);
                  }}
                  className={cn("flex cursor-pointer items-center gap-3 px-4 py-2", i === active && "bg-raised")}
                >
                  <TraderAvatar trader={{ address: row.address, avatarUrl: direct ? null : row.avatarUrl }} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {direct ? t("topbar.searchOpenAddress") : name ? <Highlighted text={name} query={trimmed} /> : truncateAddress(row.address)}
                    </p>
                    <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">{truncateAddress(row.address)}</p>
                  </div>
                  {!direct && row.pnl !== null ? (
                    <div className="shrink-0 text-right">
                      <p className={cn("num text-sm font-semibold", row.pnl >= 0 ? "text-positive" : "text-negative")}>
                        {usdCompact(row.pnl, { sign: true })}
                      </p>
                      {row.roi !== null ? (
                        <p className="num text-[0.6875rem] text-muted-foreground">
                          <span className="font-mono text-[0.625rem]">ROI</span> {searchRoi(row.roi)}
                        </p>
                      ) : null}
                    </div>
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
