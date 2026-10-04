import type { TelegramMessages } from "./index.js";

export const vi: TelegramMessages = {
  side: { buy: "Mua", sell: "Bán" },
  action: {
    openLong: "Mở long", openShort: "Mở short", addLong: "Thêm long", addShort: "Thêm short", reduceLong: "Giảm long", reduceShort: "Giảm short",
    closeLong: "Đóng long", closeShort: "Đóng short", flipToLong: "Đảo short→long", flipToShort: "Đảo long→short", liquidationLong: "Long bị thanh lý", liquidationShort: "Short bị thanh lý",
  },
  alert: { size: "Quy mô {size} · Giá {price}", rules: "Quy tắc {rules}" },
  test: "✅ Tin nhắn thử của Orbie\nTelegram đã được liên kết. Giao dịch của các trader bạn bật thông báo sẽ được gửi đến đây.\nQuản lý thông báo: {url}",
  copy: {
    header: { paper: "Orbie · Copy MÔ PHỎNG (tiền ảo, không phải tiền thật)", testnet: "Orbie · Copy TESTNET", live: "Orbie · Copy" },
    title: {
      open: "🟢 Đã mở vị thế", increase: "🟢 Đã tăng vị thế", decrease: "🟠 Đã giảm vị thế", close: "⚪ Đã đóng vị thế", filled: "✅ Lệnh đã khớp", liquidated: "🔴 Vị thế bị thanh lý",
      rejected: "⛔ Lệnh không được thực hiện", cancelled: "⛔ Lệnh đã hủy", stopped: "⏹ Đã dừng copy", fundsAdded: "💵 Đã nạp thêm", fundsWithdrawn: "💵 Đã rút", fundsReturned: "💵 Đã hoàn tiền sau khi dừng",
    },
    trader: "Đang copy {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "Lãi/lỗ đã thực hiện {pnl} (sau phí)",
    fee: "Phí {fee}",
    amount: "Số tiền {amount}",
    reason: "Lý do: {reason}",
    reasons: {
      paused: "copy đang tạm dừng hoặc đã dừng", risk: "vượt giới hạn rủi ro", market: "thiếu dữ liệu thị trường hoặc giá đã thay đổi", position: "trạng thái vị thế không phù hợp",
      settings: "cài đặt copy đã thay đổi", symbol: "thị trường này không được copy", frequency: "quá nhiều lệnh", other: "không được thực hiện",
    },
    event: "Sự kiện #{id}",
    link: "Danh mục: {url}",
  },
};
