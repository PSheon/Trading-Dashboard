"use client";

import { Component, type ReactNode } from "react";
import { useI18n } from "@/i18n/provider";

/**
 * A crash inside one card (the copy panel, the live feed) stays inside it:
 * the card shows one line and Retry, and the rest of the page keeps working.
 * The route's own error boundary is for the page as a whole.
 */
export function SectionBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  return <Boundary fallback={(retry) => (
    <div role="alert" className={className ?? "orbit-card card-pad flex flex-col items-center gap-2 text-center text-sm"}>
      <p className="text-muted-foreground">{t("common.error")}</p>
      <button type="button" onClick={retry} className="rounded text-primary-text underline outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("common.retry")}</button>
    </div>
  )}>{children}</Boundary>;
}

class Boundary extends Component<{ children: ReactNode; fallback: (retry: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(error); }
  render() { return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children; }
}
