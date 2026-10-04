import type { TelegramMessages } from "./index.js";

export const tr: TelegramMessages = {
  side: { buy: "Alım", sell: "Satım" },
  action: {
    openLong: "Long açıldı", openShort: "Short açıldı", addLong: "Long eklendi", addShort: "Short eklendi", reduceLong: "Long azaltıldı", reduceShort: "Short azaltıldı",
    closeLong: "Long kapatıldı", closeShort: "Short kapatıldı", flipToLong: "Dönüş short→long", flipToShort: "Dönüş long→short", liquidationLong: "Long likide edildi", liquidationShort: "Short likide edildi",
  },
  alert: { size: "Büyüklük {size} · Fiyat {price}", rules: "Kurallar {rules}" },
  test: "✅ Orbie test mesajı\nTelegram bağlandı. Bildirimini açtığınız trader'ların işlemleri buraya gelecek.\nBildirimleri yönetin: {url}",
  copy: {
    header: { paper: "Orbie · KAĞIT kopya (sanal fon, gerçek para değil)", testnet: "Orbie · TESTNET kopya", live: "Orbie · Kopya" },
    title: {
      open: "🟢 Pozisyon açıldı", increase: "🟢 Pozisyon artırıldı", decrease: "🟠 Pozisyon azaltıldı", close: "⚪ Pozisyon kapatıldı", filled: "✅ Emir gerçekleşti", liquidated: "🔴 Pozisyon likide edildi",
      rejected: "⛔ Emir gerçekleşmedi", cancelled: "⛔ Emir iptal edildi", stopped: "⏹ Kopya durduruldu", fundsAdded: "💵 Fon eklendi", fundsWithdrawn: "💵 Fon çekildi", fundsReturned: "💵 Durdurulunca fon iade edildi",
    },
    trader: "Kopyalanan {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "Gerçekleşen K/Z {pnl} (ücretler sonrası)",
    fee: "Ücretler {fee}",
    amount: "Tutar {amount}",
    reason: "Neden: {reason}",
    reasons: {
      paused: "kopya duraklatıldı veya durduruldu", risk: "risk limiti aşıldı", market: "piyasa verisi yok veya fiyat değişti", position: "pozisyon durumu uygun değil",
      settings: "kopya ayarları değişti", symbol: "bu piyasa kopyalanmıyor", frequency: "çok fazla emir", other: "gerçekleşmedi",
    },
    event: "Olay #{id}",
    link: "Portföy: {url}",
  },
};
