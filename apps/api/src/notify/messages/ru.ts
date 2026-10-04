import type { TelegramMessages } from "./index.js";

export const ru: TelegramMessages = {
  side: { buy: "Покупка", sell: "Продажа" },
  action: {
    openLong: "Открыт лонг", openShort: "Открыт шорт", addLong: "Добавлен лонг", addShort: "Добавлен шорт", reduceLong: "Сокращён лонг", reduceShort: "Сокращён шорт",
    closeLong: "Закрыт лонг", closeShort: "Закрыт шорт", flipToLong: "Переворот шорт→лонг", flipToShort: "Переворот лонг→шорт", liquidationLong: "Ликвидирован лонг", liquidationShort: "Ликвидирован шорт",
  },
  alert: { size: "Объём {size} · Цена {price}", rules: "Правила {rules}" },
  test: "✅ Тестовое сообщение Orbie\nTelegram подключён. Сюда будут приходить сделки трейдеров, для которых вы включили уведомления.\nНастроить уведомления: {url}",
  copy: {
    header: { paper: "Orbie · УЧЕБНОЕ копирование (виртуальные средства, не реальные деньги)", testnet: "Orbie · копирование в ТЕСТНЕТЕ", live: "Orbie · копирование" },
    title: {
      open: "🟢 Позиция открыта", increase: "🟢 Позиция увеличена", decrease: "🟠 Позиция сокращена", close: "⚪ Позиция закрыта", filled: "✅ Ордер исполнен", liquidated: "🔴 Позиция ликвидирована",
      rejected: "⛔ Ордер не исполнен", cancelled: "⛔ Ордер отменён", stopped: "⏹ Копирование остановлено", fundsAdded: "💵 Средства добавлены", fundsWithdrawn: "💵 Средства выведены", fundsReturned: "💵 Средства возвращены после остановки",
    },
    trader: "Копируете {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "Реализованный P&L {pnl} (после комиссий)",
    fee: "Комиссии {fee}",
    amount: "Сумма {amount}",
    reason: "Причина: {reason}",
    reasons: {
      paused: "копирование приостановлено или остановлено", risk: "превышен лимит риска", market: "нет рыночных данных или цена изменилась", position: "состояние позиции не позволяет",
      settings: "настройки копии изменились", symbol: "этот рынок не копируется", frequency: "слишком много ордеров", other: "не исполнен",
    },
    event: "Событие #{id}",
    link: "Портфель: {url}",
  },
};
