import type { TelegramMessages } from "./index.js";

export const ja: TelegramMessages = {
  side: { buy: "買い", sell: "売り" },
  action: {
    openLong: "ロング新規", openShort: "ショート新規", addLong: "ロング追加", addShort: "ショート追加", reduceLong: "ロング縮小", reduceShort: "ショート縮小",
    closeLong: "ロング決済", closeShort: "ショート決済", flipToLong: "ドテン ショート→ロング", flipToShort: "ドテン ロング→ショート", liquidationLong: "ロング清算", liquidationShort: "ショート清算",
  },
  alert: { size: "想定元本 {size} · 価格 {price}", rules: "ルール {rules}" },
  test: "✅ Orbie テストメッセージ\nTelegram が連携されました。通知をオンにしたトレーダーが取引すると、ここにお知らせします。\n通知の管理：{url}",
  copy: {
    header: { paper: "Orbie · ペーパーコピー（仮想資金、実際のお金ではありません）", testnet: "Orbie · テストネットコピー", live: "Orbie · コピー" },
    title: {
      open: "🟢 新規建て", increase: "🟢 ポジション追加", decrease: "🟠 ポジション縮小", close: "⚪ 決済", filled: "✅ 注文約定", liquidated: "🔴 ポジション清算",
      rejected: "⛔ 注文未執行", cancelled: "⛔ 注文取消", stopped: "⏹ コピー停止", fundsAdded: "💵 追加入金", fundsWithdrawn: "💵 出金", fundsReturned: "💵 停止後に資金返却",
    },
    trader: "コピー先 {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "実現損益 {pnl}（手数料控除後）",
    fee: "手数料 {fee}",
    amount: "金額 {amount}",
    reason: "理由：{reason}",
    reasons: {
      paused: "コピーが一時停止または停止中", risk: "リスク上限を超過", market: "市場データ不足または価格変動", position: "ポジションの状態が合わない",
      settings: "コピー設定が変更された", symbol: "コピー対象外の市場", frequency: "注文が多すぎる", other: "未執行",
    },
    event: "イベント #{id}",
    link: "ポートフォリオ：{url}",
  },
};
