"use client";

import { useQueryClient, type Query } from "@tanstack/react-query";
import { Component, useRef, type ReactNode } from "react";
import { useI18n } from "@/i18n/provider";

/**
 * A crash inside one card (the copy panel, the live feed) stays inside it:
 * the card shows one line and Retry, and the rest of the page keeps working.
 * Retry also resets the card's own queries (their cached data may be what
 * crashed it: remounting on it would crash again), so the card mounts on
 * fresh reads. The route's own error boundary is for the page as a whole.
 *
 * The card's queries are the ones that lost an observer when it unmounted
 * (recorded right after the crash). Only those are touched: one nobody
 * else watches is reset; one the rest of the page shares (the header's
 * copy overview) is refetched, not cleared and not left stale. Every other
 * cached query keeps its data.
 */
export function SectionBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const crashed = useRef(new Set<Query>());
  const record = () => {
    const cache = client.getQueryCache();
    const stop = cache.subscribe((event) => { if (event.type === "observerRemoved") crashed.current.add(event.query); });
    // The crashed subtree unsubscribes in the commit's passive effects.
    setTimeout(stop, 100);
  };
  const reset = async () => {
    const queries = [...crashed.current]; crashed.current.clear();
    await Promise.all(queries.map((query) => query.getObserversCount() === 0
      ? client.resetQueries({ queryKey: query.queryKey, exact: true })
      : client.invalidateQueries({ queryKey: query.queryKey, exact: true })));
  };
  return <Boundary onCrash={record} reset={reset} fallback={(retry) => (
    <div role="alert" className={className ?? "orbit-card card-pad flex flex-col items-center gap-2 text-center text-sm"}>
      <p className="text-muted-foreground">{t("common.error")}</p>
      <button type="button" onClick={retry} className="rounded text-primary-text underline outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("common.retry")}</button>
    </div>
  )}>{children}</Boundary>;
}

class Boundary extends Component<{ children: ReactNode; onCrash: () => void; reset: () => Promise<unknown>; fallback: (retry: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(error); this.props.onCrash(); }
  private retry = () => { void this.props.reset().catch(() => undefined); this.setState({ failed: false }); };
  render() { return this.state.failed ? this.props.fallback(this.retry) : this.props.children; }
}
