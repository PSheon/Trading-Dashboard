import type { TelegramMessages } from "./index.js";

export const es: TelegramMessages = {
  side: { buy: "Compra", sell: "Venta" },
  action: {
    openLong: "Abre long", openShort: "Abre short", addLong: "Aumenta long", addShort: "Aumenta short", reduceLong: "Reduce long", reduceShort: "Reduce short",
    closeLong: "Cierra long", closeShort: "Cierra short", flipToLong: "Gira short→long", flipToShort: "Gira long→short", liquidationLong: "Long liquidado", liquidationShort: "Short liquidado",
  },
  alert: { size: "Tamaño {size} · Precio {price}", rules: "Reglas {rules}" },
  test: "✅ Mensaje de prueba de Orbie\nTu Telegram está vinculado. Aquí llegarán las operaciones de los traders con alertas activadas.\nGestionar alertas: {url}",
  copy: {
    header: { paper: "Orbie · Copia SIMULADA (fondos virtuales, no dinero real)", testnet: "Orbie · Copia en TESTNET", live: "Orbie · Copia" },
    title: {
      open: "🟢 Posición abierta", increase: "🟢 Posición aumentada", decrease: "🟠 Posición reducida", close: "⚪ Posición cerrada", filled: "✅ Orden ejecutada", liquidated: "🔴 Posición liquidada",
      rejected: "⛔ Orden no ejecutada", cancelled: "⛔ Orden cancelada", stopped: "⏹ Copia detenida", fundsAdded: "💵 Fondos añadidos", fundsWithdrawn: "💵 Fondos retirados", fundsReturned: "💵 Fondos devueltos tras detener",
    },
    trader: "Copiando a {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "P&L realizado {pnl} (tras comisiones)",
    fee: "Comisiones {fee}",
    amount: "Importe {amount}",
    reason: "Motivo: {reason}",
    reasons: {
      paused: "la copia está pausada o detenida", risk: "supera un límite de riesgo", market: "faltan datos de mercado o el precio cambió", position: "el estado de la posición no lo permite",
      settings: "cambió la configuración de la copia", symbol: "este mercado no se copia", frequency: "demasiadas órdenes", other: "no ejecutada",
    },
    event: "Evento #{id}",
    link: "Portafolio: {url}",
  },
};
