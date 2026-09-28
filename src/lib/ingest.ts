// Raw responses → `trades` and `token_transfers`.
//
// Always a full re-parse of the wallets asked for: every raw file they have is
// read again and their rows are replaced. Cheap at this scale, and it means a
// parser fix reaches old data without anyone remembering to backfill.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { WSOL_MINT } from "./constants";
import { rawTransaction } from "./helius";
import { counterparty, walletDeltas } from "./normalize";
import { readRaw } from "./rawStore";
import type { HistoryPage, RawTransaction } from "./solana";

export const PARSER_VERSION = 1;
// A SOL leg this small moves the implied price a lot with each lamport of fee
// or rounding, so its price is marked low confidence.
const LOW_CONFIDENCE_LAMPORTS = 10_000_000n; // 0.01 SOL

export const historyDir = (rawDir: string, wallet: string) =>
  path.join(rawDir, "helius", "transaction-history", wallet);
export const rpcDir = (rawDir: string, wallet: string) => path.join(rawDir, "helius", "rpc", wallet);

function gzFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Each distinct transaction we hold for a wallet, with the programs it touched. */
export function* rawTransactions(
  rawDir: string,
  wallet: string,
): Generator<{ sig: string; raw: RawTransaction; programs: string[] }> {
  const rpc = new Map<string, RawTransaction>();
  for (const file of gzFiles(rpcDir(rawDir, wallet))) {
    for (const r of readRaw<{ signature: string }, RawTransaction | null>(file)) {
      if (r.response) rpc.set(r.request.signature, r.response);
    }
  }
  const seen = new Set<string>();
  for (const file of gzFiles(historyDir(rawDir, wallet))) {
    for (const record of readRaw<unknown, HistoryPage>(file)) {
      for (const result of record.response.data ?? []) {
        if (seen.has(result.signature)) continue;
        const raw = rawTransaction(result) ?? rpc.get(result.signature);
        if (!raw) continue;
        seen.add(result.signature);
        const programs = [
          ...new Set((result.parsed?.instructions ?? []).map((i) => i.programName || i.programId || "?")),
        ].sort();
        yield { sig: result.signature, raw, programs };
      }
    }
  }
}

export interface TradeRow {
  tx_sig: string;
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  token_amount_raw: bigint;
  decimals: number;
  quote_mint: string;
  quote_amount_raw: bigint;
  sol_lamports: bigint | null;
  fee_lamports: bigint;
  rent_lamports: bigint;
  price_sol: number | null;
  price_confidence: "low" | "normal" | null;
  programs: string[];
  slot: number;
  tx_index: number | null;
  block_time: number;
  parser_version: number;
  ingested_at: number;
}

export interface TransferRow {
  tx_sig: string;
  wallet: string;
  mint: string;
  direction: "in" | "out";
  kind: "transfer" | "complex";
  token_amount_raw: bigint;
  decimals: number;
  counterparty: string | null;
  slot: number;
  tx_index: number | null;
  block_time: number;
  parser_version: number;
  ingested_at: number;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

export function parseWallet(
  rawDir: string,
  wallet: string,
  ingestedAt = Math.floor(Date.now() / 1000),
): { trades: TradeRow[]; transfers: TransferRow[] } {
  const trades: TradeRow[] = [];
  const transfers: TransferRow[] = [];
  for (const { raw, programs } of rawTransactions(rawDir, wallet)) {
    for (const d of walletDeltas(raw, wallet)) {
      const common = {
        tx_sig: d.txSig,
        wallet: d.wallet,
        mint: d.mint,
        decimals: d.decimals,
        slot: d.slot,
        tx_index: d.txIndex,
        block_time: d.blockTime ?? 0,
        parser_version: PARSER_VERSION,
        ingested_at: ingestedAt,
      };
      if (d.kind === "trade") {
        const sol = d.quoteMint === WSOL_MINT ? abs(d.quoteAmountRaw!) : null;
        const tokens = abs(d.tokenAmountRaw);
        trades.push({
          ...common,
          side: d.side!,
          token_amount_raw: tokens,
          quote_mint: d.quoteMint!,
          quote_amount_raw: abs(d.quoteAmountRaw!),
          sol_lamports: sol,
          fee_lamports: d.feeLamports,
          rent_lamports: d.rentLamports,
          price_sol: sol ? Number(sol) / 1e9 / (Number(tokens) / 10 ** d.decimals) : null,
          price_confidence: sol === null ? null : sol < LOW_CONFIDENCE_LAMPORTS ? "low" : "normal",
          programs,
        });
      } else {
        transfers.push({
          ...common,
          direction: d.tokenAmountRaw > 0n ? "in" : "out",
          kind: d.kind,
          token_amount_raw: abs(d.tokenAmountRaw),
          counterparty: counterparty(raw, wallet, d.mint, d.tokenAmountRaw),
        });
      }
    }
  }
  return { trades, transfers };
}
