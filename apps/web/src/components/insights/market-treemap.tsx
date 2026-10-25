"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import type { CohortMarket } from "@/lib/contracts";
import { usdCompact } from "@/lib/format";
import { boardCoinLabel } from "@/lib/board-format";

interface Item extends CohortMarket { value: number }
interface Cell extends Item { x: number; y: number; w: number; h: number }

/** Squarified treemap in a 100 × 100 box (CopyDog's layout). */
export function squarify(items: Item[], x = 0, y = 0, w = 100, h = 100): Cell[] {
  const out: Cell[] = [];
  let rest = items.slice();
  while (rest.length && w > 0.01 && h > 0.01) {
    const side = Math.min(w, h);
    const scale = (w * h) / rest.reduce((s, i) => s + i.value, 0);
    let row: Item[] = [];
    let worst = Infinity;
    let rowSide = 0;
    while (rest.length) {
      const next = row.concat(rest[0]);
      const total = next.reduce((s, i) => s + i.value, 0) * scale / side;
      const ratio = Math.max(...next.map((i) => {
        const len = (i.value * scale) / total;
        return Math.max(total / len, len / total);
      }));
      if (row.length && ratio > worst) break;
      worst = ratio;
      row = next;
      rowSide = total;
      rest = rest.slice(1);
    }
    let offset = 0;
    for (const item of row) {
      const len = (item.value * scale) / rowSide;
      out.push(w >= h ? { ...item, x, y: y + offset, w: rowSide, h: len } : { ...item, x: x + offset, y, w: len, h: rowSide });
      offset += len;
    }
    if (w >= h) {
      x += rowSide;
      w -= rowSide;
    } else {
      y += rowSide;
      h -= rowSide;
    }
  }
  return out;
}

/** A display-font capital is at most this many ems wide (Fredoka's widest
 * capitals, W and M, are ~0.66em): the estimate that keeps a label whole. */
const LABEL_EM = 0.66;
/** The tile's inner padding (px-4 / px-3) and the icon with its gap. */
const TIERS = { full: { font: 24, pad: 32, icon: 20 + 8 }, small: { font: 15, pad: 24, icon: 14 + 5 } } as const;

/**
 * What a tile of `w` × `h` px can hold of `label` (QA 2026-10-25: small tiles
 * showed "SP…", "N…"): the icon and the whole label at the tile's size, at
 * the small size, the icon alone, or nothing (the colour only). The label is
 * never truncated; the tile's hover title always names it.
 */
export function tileContent(w: number, h: number, label: string, full: boolean): "full" | "small" | "icon" | "none" {
  const fits = (tier: (typeof TIERS)["full" | "small"]) => w - tier.pad - tier.icon >= label.length * tier.font * LABEL_EM;
  if (full && fits(TIERS.full)) return "full";
  if (h >= 40 && fits(TIERS.small)) return "small";
  if (h >= 36 && w >= TIERS.small.pad + 14) return "icon";
  return "none";
}

/** 各市場持倉方向: the eight largest markets by notional; area = notional,
 * colour = long (green) or short (red), stronger the more one-sided. */
export function MarketTreemap({ title, markets, loading, emptyText }: { title: string; markets: CohortMarket[] | undefined; loading: boolean;
  /** Why there is nothing to draw (the tier is still being built), instead of 「還沒有持倉資料」. */
  emptyText?: string }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 700, h: 372 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cells = useMemo(() => {
    const items = (markets ?? []).map((m) => ({ ...m, value: m.notionalLong + m.notionalShort })).filter((m) => m.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
    return items.length ? squarify(items) : [];
  }, [markets]);

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl bg-raised p-3 md:p-5">
      <div className="flex min-h-11 items-center">
        <h2 className="type-h2">{title}</h2>
      </div>
      <div ref={box} className="relative mt-3 h-[300px] md:h-[380px]" role="figure" aria-label={title}>
        {loading && !markets ? <Skeleton className="absolute inset-0 rounded-2xl bg-background/60" /> : null}
        {!loading && cells.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-raised/40 text-sm text-muted-foreground">{emptyText ?? t("insights.cohort.treemapEmpty")}</div>
        ) : null}
        {cells.map((c) => {
          const bias = c.biasPct ?? 50;
          const long = bias >= 50;
          const strength = Math.min(1, Math.abs(bias - 50) / 50);
          const px = { w: (c.w / 100) * size.w, h: (c.h / 100) * size.h };
          const full = px.h >= 90 && px.w >= 100;
          const mid = full || (px.h >= 66 && px.w >= 80);
          const tile = long ? "var(--tag-profit)" : "var(--tag-loss)";
          // The short market name ("xyz:SP500" → "SPX"), as on the boards.
          const label = boardCoinLabel(c.coin, t);
          const content = tileContent(px.w, px.h, label, full);
          return (
            <div
              key={c.coin}
              className="absolute p-0.5"
              style={{ left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%` }}
              data-testid="treemap-tile"
              data-content={content}
              title={`${label} · ${bias.toFixed(1)}% ${t("insights.cohort.long")} · ${usdCompact(c.value, { digits: 2 })}`}
            >
              <div
                className={cn("flex h-full w-full flex-col justify-between overflow-hidden rounded-[22px]", long ? "text-tag-profit-foreground" : "text-tag-loss-foreground", full ? "px-4 py-3.5" : "px-3 py-2.5")}
                style={{ backgroundColor: `color-mix(in srgb, ${tile} ${Math.round(55 + strength * 45)}%, var(--card))` }}
              >
                <div className="min-w-0">
                  {content === "none" ? null : (
                    <div className={cn("flex min-w-0 items-center font-display", content === "full" ? "gap-2 text-2xl" : "gap-[5px] text-[15px]")}>
                      <CoinIcon coin={c.coin} size={content === "full" ? 20 : 14} />
                      {content === "icon" ? null : <span className="whitespace-nowrap">{label}</span>}
                    </div>
                  )}
                  {full && content !== "none" ? (
                    <div className="mt-1 text-xs font-extrabold">
                      {long ? `${bias.toFixed(0)}% ${t("insights.cohort.long")}` : `${(100 - bias).toFixed(0)}% ${t("insights.cohort.short")}`}
                    </div>
                  ) : null}
                </div>
                {mid ? (
                  <span className="flex h-2 w-full shrink-0 gap-[3px] overflow-hidden rounded-full" aria-hidden>
                    <span className="h-full rounded-full bg-bar-long" style={{ width: `${bias}%` }} />
                    <span className="h-full rounded-full bg-bar-short" style={{ width: `${100 - bias}%` }} />
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
