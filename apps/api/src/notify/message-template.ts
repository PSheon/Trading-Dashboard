import type { actions } from "@trading-dashboard/shared/database";
import type { AlertRuleKind, Locale } from "@trading-dashboard/shared/contracts";

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

/** Telegram messages exist in 繁中 and English; every other UI language gets English. */
const SIDE_WORD: Record<"zh-TW" | "en", Record<TradeSide, string>> = {
  "zh-TW": { buy: "買入", sell: "賣出" },
  en: { buy: "Buy", sell: "Sell" },
};

/** "開多", "Close short", "翻倉 空→多"… */
export function actionLabel(action: Pick<ActionRow, "kind" | "side">, locale: Locale): string {
  const long = action.side === "long";
  if (locale !== "zh-TW") {
    const pos = long ? "long" : "short";
    switch (action.kind) {
      case "open":
        return `Open ${pos}`;
      case "add":
        return `Add ${pos}`;
      case "reduce":
        return `Reduce ${pos}`;
      case "close":
        return `Close ${pos}`;
      case "flip":
        return long ? "Flip short→long" : "Flip long→short";
      case "liquidation":
        return `Liquidated ${pos}`;
    }
  }
  const pos = long ? "多" : "空";
  switch (action.kind) {
    case "open":
      return `開${pos}`;
    case "add":
      return `加${pos}`;
    case "reduce":
      return `減${pos}`;
    case "close":
      return `平${pos}`;
    case "flip":
      return long ? "翻倉 空→多" : "翻倉 多→空";
    case "liquidation":
      return `強平${pos}`;
  }
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
  const zh = locale === "zh-TW";
  const who = params.traderName
    ? `${params.traderName} · ${shortAddress(action.address)}`
    : shortAddress(action.address);
  const lines = [
    `${side === "buy" ? "🟢" : "🔴"} ${SIDE_WORD[zh ? "zh-TW" : "en"][side]} · ${actionLabel(action, locale)} ${action.coin}`,
    who,
    zh
      ? `名目 ${formatUsd(Number(action.notionalUsd))} · 價格 ${formatPrice(Number(action.avgPx))}`
      : `Size ${formatUsd(Number(action.notionalUsd))} · Price ${formatPrice(Number(action.avgPx))}`,
  ];
  if (params.ruleKinds && params.ruleKinds.length > 0) {
    lines.push(`${zh ? "規則" : "Rules"} ${params.ruleKinds.join("+")}`);
  }
  lines.push(params.dashboardUrl);
  return lines.join("\n");
}

/** POST /me/telegram/test. */
export function renderTestMessage(locale: Locale, siteUrl: string): string {
  return locale !== "zh-TW"
    ? `✅ Orbie test message\nYour Telegram is linked. Trade alerts for the traders you turn on will arrive here.\nManage alerts: ${siteUrl}/favorites`
    : `✅ Orbie 測試訊息\nTelegram 已連結，你開啟提醒的交易員一有動作就會通知到這裡。\n管理提醒：${siteUrl}/favorites`;
}
