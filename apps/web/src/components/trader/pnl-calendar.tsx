"use client";

import { useMemo } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { TIME_ZONE } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { CALENDAR_OVERALL_SHADE, calendarShade, pnlCalendar, type CalendarCell } from "@/lib/pnl-calendar";
import { usePortfolio } from "@/lib/queries";
import { signedUsd2, usd0 } from "@/lib/trade-format";
import { signedPctCd } from "./performance";

export type CalendarUnit = "usd" | "pct";

/** "+$118K", "-$3K", "$0" (CopyDog's calendar cell in $). */
export function calendarUsd(v: number): string {
  return Math.abs(v) < 0.005 ? "$0" : `${v >= 0 ? "+" : "-"}${usd0(Math.abs(v))}`;
}

/** The cell's tooltip: "+$117.53K · +142.18%", the return left out when
 * there is none. */
export function calendarTitle(cell: { pnl: number; roi: number | null }): string {
  const pct = cell.roi == null ? "" : ` · ${cell.roi * 100 > 0 ? "+" : ""}${(cell.roi * 100).toFixed(2)}%`;
  return `${signedUsd2(cell.pnl)}${pct}`;
}

function tint(value: number | null, shade: number | null): React.CSSProperties | undefined {
  if (value == null || value === 0 || shade == null) return undefined;
  const color = value > 0 ? "var(--positive)" : "var(--negative)";
  return { background: `color-mix(in srgb, ${color} ${shade}%, var(--raised))`, color };
}

/**
 * CopyDog's 日曆 chart tab: a year × month grid of the whole account's
 * (perp + spot) monthly PnL or return, newest year first, with a 全年
 * column; the $ / % toggle picks the figure, the cell's title has both.
 * See `lib/pnl-calendar.ts` for the maths.
 */
export function PnlCalendarView({ address, unit }: { address: string; unit: CalendarUnit }) {
  const { t, locale } = useI18n();
  const portfolio = usePortfolio(address, "allTime", "all");
  const data = portfolio.data?.window === "allTime" && portfolio.data.market === "all" ? portfolio.data : undefined;
  const calendar = useMemo(() => (data ? pnlCalendar(data.pnl, data.accountValue) : null), [data]);
  const monthNames = useMemo(
    () => Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2000, m, 15)).toLocaleDateString(locale, { month: "short", timeZone: TIME_ZONE })),
    [locale],
  );
  const pct = unit === "pct";
  const max = calendar ? (pct ? calendar.maxAbsRoi : calendar.maxAbsPnl) : 0;
  const pick = (c: { pnl: number; roi: number | null }) => (pct ? c.roi : c.pnl);
  const show = (v: number | null) => (v == null ? "—" : pct ? signedPctCd(v) : calendarUsd(v));

  if (!calendar || calendar.rows.length === 0) {
    return portfolio.isPending || (!data && !portfolio.isError) ? (
      <Skeleton className="m-2 h-[324px]" />
    ) : (
      <div className="flex h-[340px] items-center justify-center text-sm text-muted-foreground">{t("trader.chart.noData")}</div>
    );
  }

  return (
    <div className="flex h-[340px] flex-col pt-1" data-testid="pnl-calendar">
      <table className="h-full w-full table-fixed border-separate [border-spacing:3px_8px]" aria-label={t("trader.chart.calendarLabel")}>
        <thead>
          <tr>
            <th className="w-[42px]" />
            {monthNames.map((name) => (
              <th key={name} scope="col" className="pb-1.5 text-center font-mono text-[11px] leading-[14px] font-medium text-subtle-foreground">
                {name}
              </th>
            ))}
            <th aria-hidden className="w-1.5 p-0" />
            <th scope="col" className="pb-1.5 text-center font-mono text-[11px] leading-[14px] font-medium text-subtle-foreground">
              {t("trader.chart.calendarOverall")}
            </th>
          </tr>
        </thead>
        <tbody>
          {calendar.rows.map((row) => (
            <tr key={row.year}>
              <th scope="row" className="w-[42px] pr-1.5 text-right font-mono text-[11px] font-medium text-subtle-foreground">
                {row.year}
              </th>
              {row.months.map((cell: CalendarCell | null, m) => {
                const v = cell ? pick(cell) : null;
                const zero = cell != null && (v == null || v === 0);
                return (
                  <td
                    key={m}
                    title={cell ? calendarTitle(cell) : ""}
                    data-cell={cell ? (zero ? "zero" : "value") : "empty"}
                    style={cell ? tint(v, calendarShade(v, max)) : undefined}
                    className={cn(
                      "num overflow-hidden rounded-md px-[3px] text-center text-[11px] font-semibold text-ellipsis whitespace-nowrap",
                      zero && "bg-raised text-subtle-foreground",
                    )}
                  >
                    {cell ? show(v) : ""}
                  </td>
                );
              })}
              <td aria-hidden className="w-1.5 p-0" />
              <td
                title={calendarTitle({ pnl: row.pnl, roi: row.roi })}
                data-cell="overall"
                style={tint(pick(row), CALENDAR_OVERALL_SHADE)}
                className="num overflow-hidden rounded-md bg-raised px-[3px] text-center text-[11px] font-bold text-ellipsis whitespace-nowrap shadow-[inset_0_0_0_1px_var(--border)]"
              >
                {show(pick(row))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
