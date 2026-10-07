"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/** Rows on one page of every paged table and list (trader tabs, the
 * portfolio's 模擬訂單, 帳務紀錄). */
export const PAGE_SIZE = 10;

/**
 * The one pager under a table or list, at the bottom of its card:
 * 上一頁 / 第 n（/ m）頁 / 下一頁, as 44 px Orbit buttons. `pages` is the page
 * count when it is known; a cursor-paged list leaves it out and says
 * whether there is a next page with `hasNext`. Nothing is drawn while
 * everything fits on the first page.
 */
export function TablePager({
  page,
  pages,
  hasNext,
  onPage,
  busy = false,
  className,
}: {
  /** 0-based. */
  page: number;
  pages?: number;
  hasNext?: boolean;
  onPage: (page: number) => void;
  /** The next page is being read: the buttons wait, 下一頁 with the spinner. */
  busy?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const next = hasNext ?? (pages !== undefined && page + 1 < pages);
  if (page === 0 && !next) return null;
  return (
    <nav
      aria-label={t("common.pages")}
      data-pager
      className={cn("flex items-center justify-between gap-3 border-t-2 border-dotted border-border px-4 py-3", className)}
    >
      <Button variant="secondary" disabled={page === 0 || busy} onClick={() => onPage(page - 1)}>
        <ChevronLeft />
        {t("common.prev")}
      </Button>
      <span className="num text-xs font-bold text-muted-foreground" aria-live="polite">
        {pages !== undefined ? t("common.page", { page: page + 1, pages }) : t("common.pageN", { page: page + 1 })}
      </span>
      <Button variant="secondary" loading={busy} disabled={!next || busy} onClick={() => onPage(page + 1)}>
        {t("common.next")}
        <ChevronRight />
      </Button>
    </nav>
  );
}

/** Client-side pages of `rows`: the current page's slice, and the pager's
 * props. A new `reset` (a re-sort, a filter) goes back to the first page;
 * a page past the end (rows went away) shows the last one. */
export function usePaged<T>(rows: readonly T[], reset?: unknown, size = PAGE_SIZE) {
  const [state, setState] = useState({ page: 0, reset });
  let page = state.page;
  if (state.reset !== reset) {
    page = 0;
    setState({ page: 0, reset });
  }
  const pages = Math.max(1, Math.ceil(rows.length / size));
  page = Math.min(page, pages - 1);
  return {
    rows: rows.slice(page * size, (page + 1) * size),
    pager: { page, pages, onPage: (p: number) => setState({ page: p, reset }) },
  };
}
