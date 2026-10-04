import type { TelegramMessages } from "./index.js";

export const en: TelegramMessages = {
  side: { buy: "Buy", sell: "Sell" },
  action: {
    openLong: "Open long", openShort: "Open short", addLong: "Add long", addShort: "Add short", reduceLong: "Reduce long", reduceShort: "Reduce short",
    closeLong: "Close long", closeShort: "Close short", flipToLong: "Flip short→long", flipToShort: "Flip long→short", liquidationLong: "Liquidated long", liquidationShort: "Liquidated short",
  },
  alert: { size: "Size {size} · Price {price}", rules: "Rules {rules}" },
  test: "✅ Orbie test message\nYour Telegram is linked. Trade alerts for the traders you turn on will arrive here.\nManage alerts: {url}",
  copy: {
    header: { paper: "Orbie · PAPER copy (simulated funds, not real money)", testnet: "Orbie · TESTNET copy", live: "Orbie · Copy" },
    title: {
      open: "🟢 Position opened", increase: "🟢 Position increased", decrease: "🟠 Position reduced", close: "⚪ Position closed", filled: "✅ Order filled", liquidated: "🔴 Position liquidated",
      rejected: "⛔ Order not executed", cancelled: "⛔ Order cancelled", stopped: "⏹ Copy stopped", fundsAdded: "💵 Funds added", fundsWithdrawn: "💵 Funds withdrawn", fundsReturned: "💵 Funds returned after stop",
    },
    trader: "Copying {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "Realized P&L {pnl} (after fees)",
    fee: "Fees {fee}",
    amount: "Amount {amount}",
    reason: "Reason: {reason}",
    reasons: {
      paused: "copying is paused or stopped", risk: "over a risk limit", market: "market data missing or the price moved", position: "the position does not allow it",
      settings: "the copy's settings changed", symbol: "this market is not copied", frequency: "too many orders", other: "not executed",
    },
    event: "Event #{id}",
    link: "Portfolio: {url}",
  },
};
