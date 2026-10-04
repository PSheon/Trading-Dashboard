import type { TelegramMessages } from "./index.js";

export const zhCN: TelegramMessages = {
  side: { buy: "买入", sell: "卖出" },
  action: {
    openLong: "开多", openShort: "开空", addLong: "加多", addShort: "加空", reduceLong: "减多", reduceShort: "减空",
    closeLong: "平多", closeShort: "平空", flipToLong: "翻仓 空→多", flipToShort: "翻仓 多→空", liquidationLong: "强平多", liquidationShort: "强平空",
  },
  alert: { size: "名义 {size} · 价格 {price}", rules: "规则 {rules}" },
  test: "✅ Orbie 测试消息\nTelegram 已连接，你开启提醒的交易员一有动作就会通知到这里。\n管理提醒：{url}",
  copy: {
    header: { paper: "Orbie · 模拟跟单（虚拟资金，不是真实资金）", testnet: "Orbie · 测试网跟单", live: "Orbie · 跟单" },
    title: {
      open: "🟢 已开仓", increase: "🟢 已加仓", decrease: "🟠 已减仓", close: "⚪ 已平仓", filled: "✅ 订单已成交", liquidated: "🔴 头寸被清算",
      rejected: "⛔ 订单未执行", cancelled: "⛔ 订单已取消", stopped: "⏹ 已停止跟单", fundsAdded: "💵 已加码", fundsWithdrawn: "💵 已提取", fundsReturned: "💵 停止后资金已退回",
    },
    trader: "跟单交易员 {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "已实现盈亏 {pnl}（已扣手续费）",
    fee: "手续费 {fee}",
    amount: "金额 {amount}",
    reason: "原因：{reason}",
    reasons: {
      paused: "跟单已暂停或停止", risk: "超过风控上限", market: "市场数据不足或价格已变动", position: "头寸状态不符",
      settings: "跟单设置已变更", symbol: "此市场不跟单", frequency: "下单过于频繁", other: "未执行",
    },
    event: "事件 #{id}",
    link: "查看投资组合：{url}",
  },
};
