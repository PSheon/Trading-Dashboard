"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { useI18n } from "@/i18n/provider";

/**
 * A crash inside one card (the copy panel, the live feed) stays inside it:
 * the card shows one line and Retry, and the rest of the page keeps working.
 * Retry also resets the card's queries (their cached data may be what
 * crashed it: remounting on it would crash again), so the card mounts on
 * fresh reads. The route's own error boundary is for the page as a whole.
 */
export function SectionBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  // The crashed card unmounted, so its queries are the ones nobody observes
  // now; the rest of the page keeps its data.
  return <Boundary reset={() => client.resetQueries({ predicate: (query) => query.getObserversCount() === 0 })} fallback={(retry) => (
    <div role="alert" className={className ?? "orbit-card card-pad flex flex-col items-center gap-2 text-center text-sm"}>
      <p className="text-muted-foreground">{t("common.error")}</p>
      <button type="button" onClick={retry} className="rounded text-primary-text underline outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("common.retry")}</button>
    </div>
  )}>{children}</Boundary>;
}

class Boundary extends Component<{ children: ReactNode; reset: () => Promise<unknown>; fallback: (retry: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(error); }
  private retry = () => { void this.props.reset().catch(() => undefined); this.setState({ failed: false }); };
  render() { return this.state.failed ? this.props.fallback(this.retry) : this.props.children; }
}
