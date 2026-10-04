"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { copyEventsKey } from "@/lib/copy";
import { coinLabel } from "@/lib/format";
import { useCopyStream, type CopyFeedEvent } from "@/lib/use-copy-stream";

/** What one copy event says, for a toast and the activity rows. */
export function describeCopyEvent(event: Pick<CopyFeedEvent, "type" | "payload">): {
  kind: "open" | "increase" | "decrease" | "close" | "liquidation" | "funds_in" | "funds_out" | "sweep" | "hub_withdrawal" | "other";
  coin: string | null;
  /** The copy's position side the fill concerns (long / short). */
  long: boolean | null;
  px: number | null;
  /** Realized PnL after the fill's fees (closes, reductions, liquidations). */
  pnl: number | null;
  amount: number | null;
} {
  const p = event.payload;
  const num = (v: unknown) => (typeof v === "string" || typeof v === "number") && Number.isFinite(Number(v)) ? Number(v) : null;
  const coin = typeof p.coin === "string" ? p.coin : null;
  const buy = p.side === "B" ? true : p.side === "A" ? false : null;
  const action = typeof p.action === "string" ? p.action : null;
  const realized = num(p.realizedPnl);
  const fee = num(p.fee) ?? 0;
  const pnl = realized === null ? null : realized - fee;
  const amount = num(p.amount);
  if (event.type === "position_liquidated") return { kind: "liquidation", coin, long: buy === null ? null : !buy, px: num(p.px), pnl, amount: null };
  if (event.type === "order_filled") {
    const kind = action === "open" || action === "increase" || action === "decrease" || action === "close" ? action : p.leg === "close" || p.leg === "stop_close" ? "decrease" : "open";
    // Opening or adding buys a long; reducing or closing a long sells.
    const long = buy === null ? null : kind === "open" || kind === "increase" ? buy : !buy;
    return { kind, coin, long, px: num(p.px), pnl: kind === "decrease" || kind === "close" ? pnl : null, amount: null };
  }
  if (event.type === "funds_added") return { kind: "funds_in", coin: null, long: null, px: null, pnl: null, amount };
  if (event.type === "funds_withdrawn") return { kind: "funds_out", coin: null, long: null, px: null, pnl: null, amount };
  if (event.type === "funds_returned") return { kind: "sweep", coin: null, long: null, px: null, pnl: null, amount };
  if (event.type === "wallet_withdrawal") return { kind: "hub_withdrawal", coin: null, long: null, px: null, pnl: null, amount };
  return { kind: "other", coin, long: null, px: null, pnl: null, amount };
}

function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

/**
 * The signed-in owner's live copy feed (CopyDog's `portfolio-feed`), mounted
 * once in the shell: pushes events into the activity list and refreshes the
 * portfolio, and toasts what CopyDog toasts (a copied open, a close with its
 * PnL, a liquidation). Paper events say so.
 */
export function CopyFeed() {
  const { status, mode, identity } = useAuth();
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => false);
  const toast = useToast();
  const { t, format } = useI18n();
  const onEvent = useCallback((event: CopyFeedEvent) => {
    const d = describeCopyEvent(event);
    const coin = d.coin ? coinLabel(d.coin) : "";
    const side = d.long === null ? "" : t(d.long ? "feed.long" : "feed.short");
    const pnl = d.pnl === null ? "" : ` (${format.usd(d.pnl, { sign: true, digits: 2 })})`;
    const paper = event.payload.mode === "paper";
    const say = (text: string) => (paper ? t("feed.paper", { text }) : text);
    if (d.kind === "open") toast.success(say(t("feed.toast.opened", { side, coin })));
    else if (d.kind === "close") toast.success(say(t("feed.toast.closed", { coin, pnl })));
    else if (d.kind === "liquidation") toast.warning(say(t("feed.toast.liquidated", { coin, pnl })));
  }, [toast, t, format]);
  useCopyStream({ enabled: status === "signedIn" && visible, eventsKey: copyEventsKey(status, mode, identity), onEvent });
  return null;
}
