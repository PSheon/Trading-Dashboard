"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import type { CohortMarket } from "@/lib/contracts";
import { coinLabel, usdCompact } from "@/lib/format";

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

/** 各市場持倉方向: the eight largest markets by notional; area = notional,
 * colour = long (green) or short (red), stronger the more one-sided. */
export function MarketTreemap({ title, markets, loading }: { title: string; markets: CohortMarket[] | undefined; loading: boolean }) {
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
    <section className="flex min-w-0 flex-col overflow-hidden orbit-card">
      <div className="flex min-h-10 items-center border-b-2 border-dotted border-border px-3">
        <h2 className="text-[13px] font-semibold">{title}</h2>
      </div>
      <div ref={box} className="relative m-2.5 h-[300px] md:h-[380px]" role="figure" aria-label={title}>
        {loading && !markets ? <Skeleton className="absolute inset-0" /> : null}
        {!loading && cells.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-raised/40 text-sm text-muted-foreground">{t("insights.cohort.treemapEmpty")}</div>
        ) : null}
        {cells.map((c) => {
          const bias = c.biasPct ?? 50;
          const long = bias >= 50;
          const strength = Math.min(1, Math.abs(bias - 50) / 50);
          const px = { w: (c.w / 100) * size.w, h: (c.h / 100) * size.h };
          const full = px.h >= 90 && px.w >= 100;
          const mid = full || (px.h >= 66 && px.w >= 80);
          const base = long ? "52 211 153" : "244 80 111";
          return (
            <div
              key={c.coin}
              className="absolute p-0.5"
              style={{ left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%` }}
              title={`${coinLabel(c.coin)} · ${bias.toFixed(1)}% ${t("insights.cohort.long")} · ${usdCompact(c.value, { digits: 2 })}`}
            >
              <div
                className={cn("flex h-full w-full flex-col justify-between overflow-hidden rounded-[6px]", full ? "px-[13px] py-[11px]" : "px-2.5 py-2")}
                style={{ backgroundColor: `rgb(${base} / ${(0.22 + strength * 0.45).toFixed(2)})` }}
              >
                <div className="min-w-0">
                  <div className={cn("flex min-w-0 items-center font-bold", full ? "gap-2 text-[17px]" : "gap-[5px] text-[12.5px] font-semibold")}>
                    <CoinIcon coin={c.coin} size={full ? 20 : 14} />
                    <span className="truncate">{coinLabel(c.coin)}</span>
                  </div>
                  {full ? (
                    <div className="mt-1 font-mono text-[11.5px] text-foreground/70">
                      {long ? `${bias.toFixed(0)}% ${t("insights.cohort.long")}` : `${(100 - bias).toFixed(0)}% ${t("insights.cohort.short")}`}
                    </div>
                  ) : null}
                </div>
                {mid ? (
                  <span className="flex h-[5px] w-full shrink-0 overflow-hidden rounded-full bg-black/30" aria-hidden>
                    <span className="h-full bg-positive" style={{ width: `${bias}%` }} />
                    <span className="h-full bg-negative" style={{ width: `${100 - bias}%` }} />
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
