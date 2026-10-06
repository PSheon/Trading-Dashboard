"use client";

import { Component, type ReactNode } from "react";

/** Next's own control flow (notFound, redirect, forbidden…) passes through. */
function isNextControl(error: unknown): boolean {
  const digest = error && typeof error === "object" && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  return digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest.startsWith("NEXT_REDIRECT") || digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING";
}

/**
 * A crash in one piece of the shell (the search, the account menu, a
 * banner, the live feed, a wallet dialog, the Privy runtime) stays in it:
 * the piece renders `fallback` (nothing by default) and the rest of the
 * site keeps working, instead of the global error page replacing it all.
 * `onError` lets the owner react (a Privy failure means signed out).
 * Change `resetKey` to try the piece again.
 */
export class IslandBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; onError?: (error: unknown) => void; resetKey?: unknown }, { failed: boolean; key: unknown }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) {
    if (isNextControl(error)) throw error;
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { failed: boolean; key: unknown }) {
    return Object.is(props.resetKey, state.key) ? null : { failed: false, key: props.resetKey };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
    this.props.onError?.(error);
  }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}
