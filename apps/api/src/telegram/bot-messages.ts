/**
 * The bot's replies in a chat. The bot doesn't know who is talking until a
 * chat is linked, so every reply carries both languages: 繁中 first, then
 * English. `site` is TELEGRAM_LINK_BASE_URL (no trailing slash).
 */

function both(zh: string, en: string): string {
  return `${zh}\n\n${en}`;
}

export const botMessages = {
  linked: (site: string, moved: boolean) =>
    both(
      [
        "✅ 已連結 Orbie！",
        moved ? "這個 Telegram 原本連結在另一個 Orbie 帳號，現在已改連到這個帳號。" : null,
        "在收藏清單或交易員頁按 🔔 開啟提醒，選擇買入／賣出／兩者與最小金額，交易員一有動作就會通知你。",
        `管理提醒：${site}/favorites`,
        "傳 /stop 可暫停通知。",
      ]
        .filter(Boolean)
        .join("\n"),
      [
        "✅ Linked to Orbie!",
        moved ? "This chat was linked to another Orbie account; it now belongs to this one." : null,
        "Tap 🔔 in your favorites or on a trader page, pick buy / sell / both and a minimum size, and you'll hear about every move.",
        `Manage alerts: ${site}/favorites`,
        "Send /stop to pause alerts.",
      ]
        .filter(Boolean)
        .join("\n"),
    ),

  /** The prompt `/start <token>` answers with; nothing is linked yet. */
  confirmLink: (account: string, moved: boolean) =>
    both(
      [
        `🔗 要把這個 Telegram 連結到 Orbie 帳號 ${account} 嗎？`,
        moved ? "這個 Telegram 目前連結在另一個 Orbie 帳號，確認後會改連到上面這個帳號。" : null,
        "只有在這是你自己的帳號時才按「確認」。如果連結是別人傳給你的，請按「取消」：確認後對方會收到你的 Telegram 名稱，提醒也會改送到對方帳號。",
      ].filter(Boolean).join("\n"),
      [
        `🔗 Link this Telegram chat to the Orbie account ${account}?`,
        moved ? "This chat is linked to another Orbie account now; confirming moves it to the one above." : null,
        "Only confirm if this is your own account. If someone else sent you this link, press Cancel: confirming would show them your Telegram username and move this chat to their account.",
      ].filter(Boolean).join("\n"),
    ),

  confirmButton: () => "✅ 確認 Confirm",
  cancelButton: () => "✖️ 取消 Cancel",

  linkCancelled: (site: string) =>
    both(
      `已取消，沒有連結任何帳號。要連結你自己的帳號，請到 Orbie 設定頁按「連接 Telegram」：${site}/settings`,
      `Cancelled; nothing was linked. To link your own account, press "Connect Telegram" in Orbie settings: ${site}/settings`,
    ),

  alreadyLinked: (site: string) =>
    both(
      `✅ 這個 Telegram 已連結 Orbie，提醒會送到這裡。\n管理提醒：${site}/favorites`,
      `✅ This chat is linked to Orbie; alerts arrive here.\nManage alerts: ${site}/favorites`,
    ),

  invalidToken: (site: string) =>
    both(
      `⚠️ 這個連結已失效或已使用過（連結 10 分鐘內有效，只能用一次）。\n請到 Orbie 設定頁重新按「連接 Telegram」：${site}/settings`,
      `⚠️ This link has expired or was already used (links last 10 minutes and work once).\nGet a new one from Orbie settings, "Connect Telegram": ${site}/settings`,
    ),

  welcome: (site: string) =>
    both(
      `👋 歡迎使用 Orbie！\n要接收交易提醒，請到 Orbie 設定頁按「連接 Telegram」：${site}/settings`,
      `👋 Welcome to Orbie!\nTo get trade alerts, open Orbie settings and press "Connect Telegram": ${site}/settings`,
    ),

  resumed: (site: string) =>
    both(
      `▶️ 已恢復通知，提醒會繼續送到這裡。\n管理提醒：${site}/favorites`,
      `▶️ Alerts resumed; they arrive here again.\nManage alerts: ${site}/favorites`,
    ),

  stopped: (site: string) =>
    both(
      `⏸ 已暫停通知。傳 /start 即可恢復，或到設定頁解除連結：${site}/settings`,
      `⏸ Alerts paused. Send /start to resume, or unlink in settings: ${site}/settings`,
    ),

  notLinked: (site: string) =>
    both(
      `這個 Telegram 尚未連結 Orbie 帳號。到設定頁按「連接 Telegram」：${site}/settings`,
      `This chat isn't linked to an Orbie account. Press "Connect Telegram" in settings: ${site}/settings`,
    ),

  privateOnly: () =>
    both("請在與機器人的私人對話中操作。", "Please use a private chat with the bot."),

  help: (site: string) =>
    both(
      `Orbie 交易提醒機器人\n/start — 連結或恢復通知\n/stop — 暫停通知\n設定：${site}/settings`,
      `Orbie trade alerts bot\n/start — link or resume alerts\n/stop — pause alerts\nSettings: ${site}/settings`,
    ),
};
