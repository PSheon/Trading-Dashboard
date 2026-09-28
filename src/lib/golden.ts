// P1 acceptance (b): golden samples. Picks single-hop trades on the pump.fun
// curve and on PumpSwap, checks our balance-delta reading against Helius's
// own decoding of the same swap (an independent parser), and writes each raw
// transaction as a regression fixture with a report for a person to confirm
// on Solscan.
//
// The token amount must match Helius exactly. The SOL leg may not: Helius
// reports the pool leg, we report what left the wallet minus network fee, tip
// and rent, so a trading bot's fee sits in the difference.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { WSOL_MINT } from "./constants";
import { rawTransaction } from "./helius";
import { historyDir } from "./ingest";
import { walletDeltas } from "./normalize";
import { readRaw } from "./rawStore";
import type { HistoryPage, RawTransaction } from "./solana";

export const VENUES = { curve: "pump", pumpswap: "pump_amm" } as const;
export type Venue = keyof typeof VENUES;

interface SwapSummary {
  protocol?: string;
  in_amount?: string;
  actual_out_amount?: string;
  input_mint?: string;
  output_mint?: string;
  inner_swaps?: unknown[];
}

export interface GoldenCase {
  venue: Venue;
  wallet: string;
  signature: string;
  raw: RawTransaction;
  helius: { input_mint: string; in_amount: string; output_mint: string; out_amount: string };
  ours: { mint: string; side: string; token_amount_raw: string; sol_lamports: string | null; fee_lamports: string };
  token_match: boolean;
  sol_diff_ratio: number | null; // ours vs Helius's pool leg
}

function summaryOf(result: Record<string, unknown>): SwapSummary | null {
  const summary = (result.parsed as { summary?: { type?: string; parsedData?: SwapSummary } } | null)?.summary;
  return summary?.type === "swap" ? (summary.parsedData ?? null) : null;
}

/** Walk a wallet's raw pages and collect single-hop swaps on one venue. */
async function* candidates(rawDir: string, wallet: string, venue: Venue): AsyncGenerator<GoldenCase> {
  const program = VENUES[venue];
  const dir = historyDir(rawDir, wallet);
  if (!existsSync(dir)) return;
  // Overlapping fetches store the same transaction more than once.
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz") && !f.includes("token-account")).sort()) {
    for await (const record of readRaw<unknown, HistoryPage>(path.join(dir, file))) {
      for (const result of record.response.data ?? []) {
        if (seen.has(result.signature)) continue;
        seen.add(result.signature);
        const s = summaryOf(result as unknown as Record<string, unknown>);
        const programs = new Set((result.parsed?.instructions ?? []).map((i) => i.programName));
        if (!s || (s.inner_swaps?.length ?? 1) > 1 || !programs.has(program)) continue;
        if (venue === "curve" && programs.has("pump_amm")) continue;
        const raw = rawTransaction(result);
        if (!raw) continue;
        const [d] = walletDeltas(raw, wallet);
        if (!d || d.kind !== "trade" || d.quoteMint !== WSOL_MINT) continue;
        const tokenSide = d.side === "buy" ? s.actual_out_amount : s.in_amount;
        const solSide = d.side === "buy" ? s.in_amount : s.actual_out_amount;
        const ourTokens = d.tokenAmountRaw < 0n ? -d.tokenAmountRaw : d.tokenAmountRaw;
        const ourSol = d.quoteAmountRaw! < 0n ? -d.quoteAmountRaw! : d.quoteAmountRaw!;
        yield {
          venue,
          wallet,
          signature: result.signature,
          raw,
          helius: {
            input_mint: s.input_mint ?? "",
            in_amount: s.in_amount ?? "",
            output_mint: s.output_mint ?? "",
            out_amount: s.actual_out_amount ?? "",
          },
          ours: {
            mint: d.mint,
            side: d.side!,
            token_amount_raw: ourTokens.toString(),
            sol_lamports: ourSol.toString(),
            fee_lamports: d.feeLamports.toString(),
          },
          token_match: tokenSide !== undefined && BigInt(tokenSide) === ourTokens,
          sol_diff_ratio: solSide ? Math.abs(Number(ourSol) - Number(solSide)) / Number(solSide) : null,
        };
      }
    }
  }
}

/** Up to `perVenue` cases per venue, spread across wallets, in a stable order. */
export async function pickGolden(rawDir: string, wallets: readonly string[], perVenue = 10): Promise<GoldenCase[]> {
  const out: GoldenCase[] = [];
  for (const venue of Object.keys(VENUES) as Venue[]) {
    const pools = await Promise.all(
      wallets.map(async (w) => (await Array.fromAsync(candidates(rawDir, w, venue))).sort((a, b) => (a.signature < b.signature ? -1 : 1))),
    );
    const picked: GoldenCase[] = [];
    // Round-robin over wallets so one busy wallet does not fill the sample.
    for (let i = 0; picked.length < perVenue && pools.some((p) => p.length > i); i++) {
      for (const pool of pools) if (pool[i] && picked.length < perVenue) picked.push(pool[i]);
    }
    out.push(...picked);
  }
  return out;
}

export function writeGolden(cases: readonly GoldenCase[], fixtureDir: string, reportFile: string): void {
  mkdirSync(fixtureDir, { recursive: true });
  for (const c of cases) {
    writeFileSync(path.join(fixtureDir, `${c.venue}-${c.signature.slice(0, 16)}.json`), JSON.stringify(c, null, 1) + "\n");
  }
  const lines = [
    "# P1 golden samples",
    "",
    "Written for: whoever confirms P1 acceptance (b) by hand.",
    "",
    "Each row is one swap. `ours` comes from the transaction's own balances; `Helius` from Helius's decoding of the",
    "swap instruction. Tokens must match exactly. SOL is the pool leg on Helius's side and what left the wallet on",
    "ours, so a trading bot's fee shows up as a difference. Open the Solscan link and tick the row if the token",
    "amount and direction on Solscan agree with ours.",
    "",
    "| ✓ | Venue | Side | Tokens (ours) | Tokens match Helius | SOL (ours) | SOL vs Helius | Tx |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...cases.map(
      (c) =>
        `| [ ] | ${c.venue} | ${c.ours.side} | ${c.ours.token_amount_raw} | ${c.token_match ? "yes" : "**no**"} | ${(
          Number(c.ours.sol_lamports) / 1e9
        ).toFixed(6)} | ${c.sol_diff_ratio === null ? "–" : `${(c.sol_diff_ratio * 100).toFixed(2)}%`} | [${c.signature.slice(0, 10)}…](https://solscan.io/tx/${c.signature}) |`,
    ),
    "",
  ];
  mkdirSync(path.dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, lines.join("\n"));
}
