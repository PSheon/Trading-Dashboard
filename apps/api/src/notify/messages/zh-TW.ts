/**
 * Telegram messages, 繁體中文: the source catalog. Every other language has
 * exactly these keys and placeholders (test/telegram-messages.spec.ts).
 * Amounts and prices are formatted by the renderer ($, en-US digits, as the
 * site does in every language).
 */
export const zhTW = {
  side: { buy: "買入", sell: "賣出" },
  action: {
    openLong: "開多", openShort: "開空", addLong: "加多", addShort: "加空", reduceLong: "減多", reduceShort: "減空",
    closeLong: "平多", closeShort: "平空", flipToLong: "翻倉 空→多", flipToShort: "翻倉 多→空", liquidationLong: "強平多", liquidationShort: "強平空",
  },
  alert: { size: "名目 {size} · 價格 {price}", rules: "規則 {rules}" },
  test: "✅ Orbie 測試訊息\nTelegram 已連結，你開啟提醒的交易員一有動作就會通知到這裡。\n管理提醒：{url}",
  copy: {
    header: { paper: "Orbie · 模擬跟單（虛擬資金，不是真實資金）", testnet: "Orbie · 測試網跟單", live: "Orbie · 跟單" },
    title: {
      open: "🟢 已開倉", increase: "🟢 已加倉", decrease: "🟠 已減倉", close: "⚪ 已平倉", filled: "✅ 訂單已成交", liquidated: "🔴 部位遭清算",
      rejected: "⛔ 訂單未執行", cancelled: "⛔ 訂單已取消", stopped: "⏹ 已停止跟單", fundsAdded: "💵 已加碼", fundsWithdrawn: "💵 已提領", fundsReturned: "💵 停止後資金已退回",
    },
    trader: "跟單交易員 {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "已實現損益 {pnl}（已扣手續費）",
    fee: "手續費 {fee}",
    amount: "金額 {amount}",
    reason: "原因：{reason}",
    reasons: {
      paused: "跟單已暫停或停止", risk: "超過風控上限", market: "市場資料不足或價格已變動", position: "部位狀態不符",
      settings: "跟單設定已變更", symbol: "此市場不跟單", frequency: "下單過於頻繁", other: "未執行",
    },
    event: "事件 #{id}",
    link: "查看投資組合：{url}",
  },
} as const;
