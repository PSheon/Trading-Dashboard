import type { TelegramMessages } from "./index.js";

export const pt: TelegramMessages = {
  side: { buy: "Compra", sell: "Venda" },
  action: {
    openLong: "Abre long", openShort: "Abre short", addLong: "Aumenta long", addShort: "Aumenta short", reduceLong: "Reduz long", reduceShort: "Reduz short",
    closeLong: "Fecha long", closeShort: "Fecha short", flipToLong: "Vira short→long", flipToShort: "Vira long→short", liquidationLong: "Long liquidado", liquidationShort: "Short liquidado",
  },
  alert: { size: "Tamanho {size} · Preço {price}", rules: "Regras {rules}" },
  test: "✅ Mensagem de teste da Orbie\nSeu Telegram está conectado. As operações dos traders com alertas ativados chegarão aqui.\nGerenciar alertas: {url}",
  copy: {
    header: { paper: "Orbie · Cópia SIMULADA (fundos virtuais, não é dinheiro real)", testnet: "Orbie · Cópia em TESTNET", live: "Orbie · Cópia" },
    title: {
      open: "🟢 Posição aberta", increase: "🟢 Posição aumentada", decrease: "🟠 Posição reduzida", close: "⚪ Posição fechada", filled: "✅ Ordem executada", liquidated: "🔴 Posição liquidada",
      rejected: "⛔ Ordem não executada", cancelled: "⛔ Ordem cancelada", stopped: "⏹ Cópia parada", fundsAdded: "💵 Fundos adicionados", fundsWithdrawn: "💵 Fundos sacados", fundsReturned: "💵 Fundos devolvidos após parar",
    },
    trader: "Copiando {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "P&L realizado {pnl} (após taxas)",
    fee: "Taxas {fee}",
    amount: "Valor {amount}",
    reason: "Motivo: {reason}",
    reasons: {
      paused: "a cópia está pausada ou parada", risk: "acima de um limite de risco", market: "faltam dados de mercado ou o preço mudou", position: "o estado da posição não permite",
      settings: "as configurações da cópia mudaram", symbol: "este mercado não é copiado", frequency: "ordens demais", other: "não executada",
    },
    event: "Evento #{id}",
    link: "Portfólio: {url}",
  },
};
