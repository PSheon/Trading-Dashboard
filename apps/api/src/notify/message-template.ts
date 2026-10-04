import type { actions } from "@trading-dashboard/shared/database";
import type { AlertRuleKind, Locale } from "@trading-dashboard/shared/contracts";

import { fill, telegramMessages } from "./messages/index.js";

type ActionRow = typeof actions.$inferSelect;

/** Which side of the book an action traded on. Actions carry the
 * position's side (long/short), so the trade direction follows from the
 * kind: opening, adding to or flipping into a long buys; reducing, closing
 * or being liquidated out of a long sells; the mirror for shorts. */
export type TradeSide = "buy" | "sell";

export function tradeSideOf(action: Pick<ActionRow, "kind" | "side">): TradeSide {
  const long = action.side === "long";
  switch (action.kind) {
    case "open":
    case "add":
    case "flip": // `side` is the new position's side
      return long ? "buy" : "sell";
    case "reduce":
    case "close":
    case "liquidation": // `side` is the side that was closed
      return long ? "sell" : "buy";
  }
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "開多", "Close short", "翻倉 空→多"… in the recipient's language. */
export function actionLabel(action: Pick<ActionRow, "kind" | "side">, locale: Locale): string {
  const long = action.side === "long";
  const a = telegramMessages(locale).action;
  switch (action.kind) {
    case "open": return long ? a.openLong : a.openShort;
    case "add": return long ? a.addLong : a.addShort;
    case "reduce": return long ? a.reduceLong : a.reduceShort;
    case "close": return long ? a.closeLong : a.closeShort;
    case "flip": return long ? a.flipToLong : a.flipToShort;
    case "liquidation": return long ? a.liquidationLong : a.liquidationShort;
  }
}

/** The longest trader name a message carries. */
export const DISPLAY_NAME_MAX = 40;

/**
 * A trader's display name as it may appear in a Telegram message (review
 * finding 35). The name is someone else's text — a leaderboard name anyone
 * can set — and Telegram turns anything link-shaped in a plain message into
 * a tappable link sent by the official bot. So: control, formatting and
 * invisible characters are removed, whitespace is one space, the length is
 * capped, and the characters that make text a link, a mention, a command
 * or a hashtag are swapped for look-alikes that don't ("example.com" →
 * "example․com", "@name" → "＠name"). Empty when nothing is left.
 */
export function safeDisplayName(value: string): string {
  const clean = value
    // Control, format (zero-width, bidi overrides), surrogates, private use.
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  const capped = chars.length > DISPLAY_NAME_MAX ? `${chars.slice(0, DISPLAY_NAME_MAX - 1).join("").trimEnd()}…` : clean;
  return capped
    .replace(/:\/\//g, ":∕∕")
    .replace(/\./g, "․")
    .replace(/@/g, "＠")
    .replace(/#/g, "＃")
    .replace(/\//g, "∕");
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

/** Enough significant digits for BTC and for sub-cent coins alike. */
export function formatPrice(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 6 })}`;
}

/**
 * One trade alert, CopyDog-style: direction and action on the first line,
 * who, how much and at what price, then the trader page. `ruleKinds` is set
 * only for an admin whose default rules matched (imported leaders), so they
 * can tell why they got it.
 *
 *   🟢 買入 · 開多 BTC
 *   Whale · 0x1234…abcd
 *   名目 $1,250,000 · 價格 $60,123.5
 *   https://app.orbie.fun/trader/0x…
 */
export function renderAlertMessage(params: {
  locale: Locale;
  traderName: string | null;
  action: Pick<ActionRow, "address" | "coin" | "kind" | "side" | "notionalUsd" | "avgPx">;
  dashboardUrl: string;
  ruleKinds?: AlertRuleKind[];
}): string {
  const { locale, action } = params;
  const side = tradeSideOf(action);
  const m = telegramMessages(locale);
  const name = params.traderName ? safeDisplayName(params.traderName) : "";
  const who = name ? `${name} · ${shortAddress(action.address)}` : shortAddress(action.address);
  const lines = [
    `${side === "buy" ? "🟢" : "🔴"} ${m.side[side]} · ${actionLabel(action, locale)} ${action.coin}`,
    who,
    fill(m.alert.size, { size: formatUsd(Number(action.notionalUsd)), price: formatPrice(Number(action.avgPx)) }),
  ];
  if (params.ruleKinds && params.ruleKinds.length > 0) {
    lines.push(fill(m.alert.rules, { rules: params.ruleKinds.join("+") }));
  }
  lines.push(params.dashboardUrl);
  return lines.join("\n");
}

/** POST /me/telegram/test, in the recipient's language. */
export function renderTestMessage(locale: Locale, siteUrl: string): string {
  return fill(telegramMessages(locale).test, { url: `${siteUrl}/favorites` });
}
