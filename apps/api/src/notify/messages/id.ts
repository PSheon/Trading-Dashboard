import type { TelegramMessages } from "./index.js";

export const id: TelegramMessages = {
  side: { buy: "Beli", sell: "Jual" },
  action: {
    openLong: "Buka long", openShort: "Buka short", addLong: "Tambah long", addShort: "Tambah short", reduceLong: "Kurangi long", reduceShort: "Kurangi short",
    closeLong: "Tutup long", closeShort: "Tutup short", flipToLong: "Balik short→long", flipToShort: "Balik long→short", liquidationLong: "Long dilikuidasi", liquidationShort: "Short dilikuidasi",
  },
  alert: { size: "Ukuran {size} · Harga {price}", rules: "Aturan {rules}" },
  test: "✅ Pesan uji Orbie\nTelegram kamu sudah terhubung. Trade dari trader yang notifikasinya kamu aktifkan akan dikirim ke sini.\nKelola notifikasi: {url}",
  copy: {
    header: { paper: "Orbie · Salinan SIMULASI (dana virtual, bukan uang sungguhan)", testnet: "Orbie · Salinan TESTNET", live: "Orbie · Salinan" },
    title: {
      open: "🟢 Posisi dibuka", increase: "🟢 Posisi ditambah", decrease: "🟠 Posisi dikurangi", close: "⚪ Posisi ditutup", filled: "✅ Order tereksekusi", liquidated: "🔴 Posisi dilikuidasi",
      rejected: "⛔ Order tidak dieksekusi", cancelled: "⛔ Order dibatalkan", stopped: "⏹ Salinan dihentikan", fundsAdded: "💵 Dana ditambahkan", fundsWithdrawn: "💵 Dana ditarik", fundsReturned: "💵 Dana dikembalikan setelah dihentikan",
    },
    trader: "Menyalin {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "P&L terealisasi {pnl} (setelah biaya)",
    fee: "Biaya {fee}",
    amount: "Jumlah {amount}",
    reason: "Alasan: {reason}",
    reasons: {
      paused: "salinan dijeda atau dihentikan", risk: "melebihi batas risiko", market: "data pasar tidak ada atau harga berubah", position: "status posisi tidak memungkinkan",
      settings: "pengaturan salinan berubah", symbol: "pasar ini tidak disalin", frequency: "terlalu banyak order", other: "tidak dieksekusi",
    },
    event: "Peristiwa #{id}",
    link: "Portofolio: {url}",
  },
};
