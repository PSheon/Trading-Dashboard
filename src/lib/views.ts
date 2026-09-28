// What the pages show, shaped for rendering: plain numbers (SOL, not
// lamports) so everything crosses the server/client boundary as-is.

import { lit } from "./db";
import type { Metrics } from "./metrics";
import { server } from "./server";
import { discoveredLater } from "./universe";
import { loadWallets, type WalletRow } from "./wallets";

const SOL = 1e9;
const toSol = (v: bigint | null) => (v === null ? null : Number(v) / SOL);

export type WalletListRow = WalletRow &
  Partial<Omit<Metrics, "wallet" | "as_of_date">> & { note: string; discovered_later: boolean };

export function listDates(): string[] {
  return server().ctx.wh.days("wallet_metrics_daily").sort().reverse();
}

/** Every registered wallet, with that day's metrics where it has them. */
export async function walletList(
  asOf?: string,
): Promise<{ asOfDate: string | null; rows: WalletListRow[]; now: number }> {
  const { ctx, notes } = server();
  const days = listDates();
  const day = asOf && days.includes(asOf) ? asOf : (days[0] ?? null);
  const [registry, metrics] = await Promise.all([
    loadWallets(ctx.wh),
    day ? ctx.wh.read<Metrics>("wallet_metrics_daily", `as_of_date = DATE ${lit(day)}`) : Promise.resolve([]),
  ]);
  const byWallet = new Map(metrics.map((m) => [m.wallet, m]));
  const allNotes = notes.all();
  const rows = registry.map((w) => {
    const m: Partial<Metrics> = { ...byWallet.get(w.address) };
    delete m.wallet;
    delete m.as_of_date;
    return {
      ...w,
      ...m,
      note: allNotes.get(w.address)?.note ?? "",
      discovered_later: discoveredLater(w.first_seen_at, day, days[0] ?? null),
    };
  });
  // Read once here so the server render and hydration format times alike.
  return { asOfDate: day, rows, now: Math.floor(Date.now() / 1000) };
}

export interface PositionView {
  mint: string;
  position_seq: number;
  opened_at: number;
  closed_at: number | null;
  cost_sol: number;
  proceeds_sol: number;
  pnl_sol: number | null;
  status: "open" | "complete" | "transferred out" | "unknown cost";
}

export interface TradeView {
  tx_sig: string;
  mint: string;
  side: string;
  tokens: number; // whole tokens
  sol: number | null;
  fee_sol: number;
  price_sol: number | null;
  low_confidence: boolean;
  block_time: number;
}

export async function walletDetail(address: string) {
  const { ctx, notes } = server();
  const registry = await loadWallets(ctx.wh);
  const wallet = registry.find((w) => w.address === address);
  if (!wallet) return null;
  const where = `wallet = ${lit(address)}`;
  const [metrics, positions, trades] = await Promise.all([
    ctx.wh.read<Metrics>("wallet_metrics_daily", where, "as_of_date"),
    ctx.wh.read<{
      mint: string; position_seq: number; opened_at: number; closed_at: number | null; cost_lamports: bigint;
      proceeds_lamports: bigint; realized_pnl_lamports: bigint | null; complete: boolean; has_transfer_out: boolean;
    }>("positions", where, "opened_at DESC"),
    ctx.wh.read<{
      tx_sig: string; mint: string; side: string; token_amount_raw: bigint; decimals: number; sol_lamports: bigint | null;
      fee_lamports: bigint; price_sol: number | null; price_confidence: string | null; block_time: number;
    }>("trades", where, "block_time DESC"),
  ]);
  return {
    wallet,
    note: notes.get(address)?.note ?? "",
    metrics,
    positions: positions.map<PositionView>((p) => ({
      mint: p.mint,
      position_seq: p.position_seq,
      opened_at: p.opened_at,
      closed_at: p.closed_at,
      cost_sol: toSol(p.cost_lamports)!,
      proceeds_sol: toSol(p.proceeds_lamports)!,
      pnl_sol: toSol(p.realized_pnl_lamports),
      status: p.closed_at === null ? "open" : p.complete ? "complete" : p.has_transfer_out ? "transferred out" : "unknown cost",
    })),
    trades: trades.map<TradeView>((t) => ({
      tx_sig: t.tx_sig,
      mint: t.mint,
      side: t.side,
      tokens: Number(t.token_amount_raw) / 10 ** t.decimals,
      sol: toSol(t.sol_lamports),
      fee_sol: toSol(t.fee_lamports)!,
      price_sol: t.price_sol,
      low_confidence: t.price_confidence === "low",
      block_time: t.block_time,
    })),
  };
}

export type WalletDetail = NonNullable<Awaited<ReturnType<typeof walletDetail>>>;
