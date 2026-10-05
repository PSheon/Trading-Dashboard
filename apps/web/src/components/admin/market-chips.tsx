"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GripVertical, Plus, X } from "lucide-react";
import { cn } from "cn";

import { CoinIcon } from "@/components/traders/coin-icon";
import { Select } from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import type { MarketNamesResponse } from "@/lib/contracts";
import { coinLabel } from "@/lib/format";

export const MAX_MARKETS = 16;

/** Hyperliquid's market names and 24h volumes (GET /discover/markets). */
export function useMarketNames() {
  return useQuery({
    queryKey: ["discover", "markets"],
    queryFn: ({ signal }) => api.get<MarketNamesResponse>("/discover/markets", signal),
    staleTime: 5 * 60_000,
  });
}

const isStock = (coin: string) => coin.includes(":");

/**
 * A market list edited as chips (C-AdminNew-Settings): drag a chip, or
 * focus its handle and use the arrow keys (Home / End), to reorder; × removes
 * it; "+ 新增" is a searchable list of the exchange's markets with their type
 * and 24h volume, those already chosen marked 已選. A chip whose market is no
 * longer listed is greyed. At most 16.
 */
export function MarketChips({ id, label, hint, value, onChange, kind, disabled = false }: {
  id: string;
  label: string;
  hint?: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Which markets may be added: main-dex coins, HIP-3 stocks, or both. */
  kind: "crypto" | "stocks" | "any";
  disabled?: boolean;
}) {
  const { t, format } = useI18n();
  const markets = useMarketNames();
  const listed = markets.data?.markets ? new Set(markets.data.markets) : null;
  const volumes = markets.data?.volumes ?? {};
  const [dragging, setDragging] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [focusCoin, setFocusCoin] = useState<string | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (focusCoin) handles.current.get(focusCoin)?.focus();
  }, [focusCoin, value]);

  const move = (coin: string, to: number) => {
    const from = value.indexOf(coin);
    const target = Math.max(0, Math.min(value.length - 1, to));
    if (from < 0 || from === target) return;
    const next = [...value];
    next.splice(from, 1);
    next.splice(target, 0, coin);
    onChange(next);
    setFocusCoin(coin);
    setAnnounce(t("admin.markets.moved", { coin: coinLabel(coin), position: target + 1, total: value.length }));
  };
  const remove = (coin: string) => {
    const index = value.indexOf(coin);
    onChange(value.filter((c) => c !== coin));
    setAnnounce(t("admin.markets.removed", { coin: coinLabel(coin) }));
    setFocusCoin(value[index + 1] ?? value[index - 1] ?? null);
  };

  const options = (markets.data?.markets ?? [])
    .filter((coin) => (kind === "any" ? true : kind === "stocks" ? isStock(coin) : !isStock(coin)))
    .sort((a, b) => (volumes[b] ?? -1) - (volumes[a] ?? -1) || a.localeCompare(b))
    .map((coin) => {
      const chosen = value.includes(coin);
      const volume = volumes[coin];
      return {
        value: coin,
        text: `${coinLabel(coin)} ${coin}`,
        label: <span className="inline-flex items-center gap-2"><CoinIcon coin={coin} size={20} />{coin}</span>,
        hint: chosen ? t("admin.markets.chosen") : `${t(isStock(coin) ? "admin.markets.stock" : "admin.markets.crypto")}${volume === undefined ? "" : ` · ${t("admin.markets.volume", { value: format.usd(volume, { compact: true }) })}`}`,
        disabled: chosen,
      };
    });
  const full = value.length >= MAX_MARKETS;

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span id={`${id}-label`} className="type-th">{label}</span>
        <span className="num type-th">{value.length} / {MAX_MARKETS}</span>
      </div>
      <div className="rounded-[22px] bg-inset p-2.5">
        <ul aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2" onDragOver={(e) => { if (dragging) e.preventDefault(); }}>
          {value.map((coin, index) => {
            const delisted = listed !== null && !listed.has(coin);
            return (
              <li
                key={coin}
                draggable={!disabled}
                onDragStart={(e) => { setDragging(coin); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", coin); }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => { if (dragging && dragging !== coin) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                onDrop={(e) => { e.preventDefault(); if (dragging) move(dragging, index); setDragging(null); }}
                className={cn(
                  "flex h-[38px] items-center gap-1 rounded-[19px] bg-card pr-1.5 pl-1 text-sm font-extrabold shadow-[0_0_0_2px_var(--card-ring)] transition-opacity",
                  dragging === coin && "opacity-50",
                  delisted && "text-muted-foreground opacity-60",
                )}
                title={delisted ? t("admin.markets.delisted") : undefined}
              >
                <button
                  type="button"
                  ref={(el) => { if (el) handles.current.set(coin, el); else handles.current.delete(coin); }}
                  disabled={disabled}
                  aria-label={t("admin.markets.reorder", { coin: coinLabel(coin), position: index + 1, total: value.length })}
                  aria-describedby={`${id}-keys`}
                  onKeyDown={(e) => {
                    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
                    if (step) { e.preventDefault(); move(coin, index + step); }
                    else if (e.key === "Home") { e.preventDefault(); move(coin, 0); }
                    else if (e.key === "End") { e.preventDefault(); move(coin, value.length - 1); }
                    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(coin); }
                  }}
                  className="flex h-8 w-6 cursor-grab items-center justify-center rounded-full text-subtle-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                >
                  <GripVertical className="size-3.5" aria-hidden />
                </button>
                <CoinIcon coin={coin} size={20} />
                <span className={cn("ml-1", delisted && "line-through")}>{coinLabel(coin)}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t("admin.markets.remove", { coin: coinLabel(coin) })}
                  onClick={() => remove(coin)}
                  className="ml-1 flex size-7 items-center justify-center rounded-full bg-(--seg-track,var(--raised)) text-foreground outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
          <li>
            <Select
              size="row"
              searchable
              label={t("admin.markets.add", { label })}
              display={<span className="inline-flex items-center gap-1.5"><Plus className="size-4" aria-hidden />{t("admin.markets.addShort")}</span>}
              placeholder={t("admin.markets.addShort")}
              searchPlaceholder={t("admin.markets.search")}
              emptyText={markets.isError ? t("admin.markets.unavailable") : !markets.data ? t("admin.markets.loading") : t("admin.markets.none")}
              value=""
              disabled={disabled || full}
              onValueChange={(coin) => {
                if (!coin || value.includes(coin) || full) return;
                onChange([...value, coin]);
                setAnnounce(t("admin.markets.added", { coin: coinLabel(coin) }));
              }}
              options={options}
              className="h-[38px] border-2 border-dashed border-border-strong bg-transparent text-muted-foreground hover:bg-card"
            />
          </li>
        </ul>
      </div>
      <p id={`${id}-keys`} className="type-caption">{hint ? `${hint} ` : ""}{t("admin.markets.keys")}</p>
      <p aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
}
