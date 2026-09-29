// R0 acceptance: our trades against GMGN's independent reading of the same
// wallet. GMGN reports the pool leg (no trading-bot fees) and we report what
// left and reached the wallet, so SOL amounts are compared for information
// only; coverage, side and token amount must agree.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lit } from "./db";
import type { GmgnActivity, GmgnClient } from "./gmgn";
import type { TradeRow } from "./ingest";
import { WSOL_MINT } from "./constants";
import { appendRaw, readRaw } from "./rawStore";
import type { Warehouse } from "./store";
import { loadWallets } from "./wallets";

export const THRESHOLDS = { coverage: 0.99, side: 0.99, tokens: 0.95 };
// Launchpads and trading bots take up to 3% of a swap in the token itself.
// GMGN reports the pool's side of the swap and we report what reached the
// wallet, so a gap of that shape in the fee's direction is explained.
const MAX_TOKEN_FEE = 0.031;
// GMGN writes native SOL as So1…111 and wrapped SOL as the WSOL mint.
const GMGN_SOL = new Set([WSOL_MINT, "So11111111111111111111111111111111111111111"]);

export interface WalletCheck {
  wallet: string;
  ours: number; // SOL-quoted trades
  ours_stable: number; // stablecoin-quoted trades, reported apart: GMGN records few of them
  gmgn: number; // GMGN (signature, token) pairs inside our history window
  matched: number;
  matched_stable: number;
  side_agree: number;
  quote_agree: number; // GMGN also quotes it in SOL
  tokens_exact: number;
  tokens_fee: number; // differs by a token-side fee of at most MAX_TOKEN_FEE
  gmgn_only: number;
  gmgn_only_multi_token: number; // from transactions where GMGN sees several tokens swapped; we record those as complex
  sol_median_diff: number | null; // |ours − GMGN| / GMGN over SOL-quoted matches
}

interface GmgnLeg {
  tokens: number; // signed: bought > 0
  sol: number;
  solQuoted: boolean;
}

/** GMGN rows netted to our grain, (signature, token), as we net balance changes. */
function gmgnLegs(rows: readonly GmgnActivity[], since: number): Map<string, GmgnLeg> {
  const legs = new Map<string, GmgnLeg>();
  for (const a of rows) {
    if ((a.event_type !== "buy" && a.event_type !== "sell") || a.timestamp < since) continue;
    const k = `${a.tx_hash}|${a.token.address}`;
    const leg = legs.get(k) ?? { tokens: 0, sol: 0, solQuoted: true };
    const sign = a.event_type === "buy" ? 1 : -1;
    leg.tokens += sign * Number(a.token_amount);
    leg.sol += Number(a.quote_amount ?? 0);
    leg.solQuoted &&= GMGN_SOL.has(a.quote_token?.token_address ?? "");
    legs.set(k, leg);
  }
  return legs;
}

export function compareWallet(wallet: string, ours: readonly TradeRow[], gmgn: readonly GmgnActivity[], since: number): WalletCheck {
  const legs = gmgnLegs(gmgn, since);
  const mintsPerTx = new Map<string, number>();
  for (const k of legs.keys()) {
    const sig = k.split("|")[0];
    mintsPerTx.set(sig, (mintsPerTx.get(sig) ?? 0) + 1);
  }
  const c: WalletCheck = {
    wallet, ours: 0, ours_stable: 0, gmgn: legs.size, matched: 0, matched_stable: 0, side_agree: 0, quote_agree: 0,
    tokens_exact: 0, tokens_fee: 0, gmgn_only: 0, gmgn_only_multi_token: 0, sol_median_diff: null,
  };
  const solDiffs: number[] = [];
  const seen = new Set<string>();
  for (const t of ours) {
    const k = `${t.tx_sig}|${t.mint}`;
    seen.add(k);
    const stable = t.quote_mint !== WSOL_MINT;
    if (stable) c.ours_stable += 1;
    else c.ours += 1;
    const leg = legs.get(k);
    if (!leg) continue;
    if (stable) {
      c.matched_stable += 1;
      continue;
    }
    c.matched += 1;
    if (leg.solQuoted) c.quote_agree += 1;
    const side = leg.tokens > 0 ? "buy" : "sell";
    if (side !== t.side) continue;
    c.side_agree += 1;
    const mine = Number(t.token_amount_raw) / 10 ** t.decimals;
    const theirs = Math.abs(leg.tokens);
    if (Math.abs(theirs - mine) <= Math.max(1e-9, mine * 1e-6)) c.tokens_exact += 1;
    else if (t.side === "buy" ? mine < theirs && mine >= theirs * (1 - MAX_TOKEN_FEE) : theirs < mine && theirs >= mine * (1 - MAX_TOKEN_FEE)) c.tokens_fee += 1;
    if (leg.solQuoted && leg.sol > 0) solDiffs.push(Math.abs(Number(t.quote_amount_raw) / 1e9 - leg.sol) / leg.sol);
  }
  for (const k of legs.keys()) {
    if (seen.has(k)) continue;
    c.gmgn_only += 1;
    if ((mintsPerTx.get(k.split("|")[0]) ?? 0) > 1) c.gmgn_only_multi_token += 1;
  }
  solDiffs.sort((x, y) => x - y);
  c.sol_median_diff = solDiffs.length ? solDiffs[Math.floor(solDiffs.length / 2)] : null;
  return c;
}

export function summarizeChecks(checks: readonly WalletCheck[]) {
  const sum = (k: keyof WalletCheck) => checks.reduce((s, c) => s + (c[k] as number), 0);
  const ours = sum("ours"), matched = sum("matched"), sideAgree = sum("side_agree");
  const rates = {
    coverage: ours ? matched / ours : null,
    side: matched ? sideAgree / matched : null,
    tokens: sideAgree ? (sum("tokens_exact") + sum("tokens_fee")) / sideAgree : null,
  };
  const pass = Object.entries(THRESHOLDS).every(([k, v]) => (rates[k as keyof typeof rates] ?? 0) >= v);
  const oursStable = sum("ours_stable");
  return {
    wallets: checks.length, ours, matched, ...rates,
    tokens_exact: sideAgree ? sum("tokens_exact") / sideAgree : null,
    quote: matched ? sum("quote_agree") / matched : null,
    ours_stable: oursStable, stable_coverage: oursStable ? sum("matched_stable") / oursStable : null,
    gmgn: sum("gmgn"), gmgn_only: sum("gmgn_only"), gmgn_only_multi_token: sum("gmgn_only_multi_token"), pass,
  };
}

const activityDir = (rawDir: string, wallet: string) => path.join(rawDir, "gmgn", "activity", wallet);

/** The latest saved GMGN fetch for a wallet, or null. */
async function cachedActivity(rawDir: string, wallet: string): Promise<GmgnActivity[] | null> {
  const dir = activityDir(rawDir, wallet);
  const latest = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort().at(-1) : undefined;
  if (!latest) return null;
  const rows: GmgnActivity[] = [];
  for await (const r of readRaw<unknown, { activities: GmgnActivity[] }>(path.join(dir, latest))) rows.push(...r.response.activities);
  return rows;
}

/** Fetch GMGN activity for each wallet (kept in raw/gmgn), compare, and write a report. */
export async function gmgnCheck(
  wh: Warehouse,
  gmgn: GmgnClient,
  rawDir: string,
  addresses: readonly string[],
  opts: { now: number; stamp: string; reportFile: string; cached?: boolean },
) {
  const historyFrom = new Map((await loadWallets(wh)).map((w) => [w.address, w.history_from]));
  const checks: WalletCheck[] = [];
  const errors: { wallet: string; message: string }[] = [];
  for (const wallet of addresses) {
    const since = historyFrom.get(wallet) ?? opts.now - 180 * 86_400;
    try {
      let rows = opts.cached ? await cachedActivity(rawDir, wallet) : null;
      if (!rows) {
        rows = [];
        for await (const page of gmgn.walletActivity(wallet, { since })) {
        appendRaw(path.join(activityDir(rawDir, wallet), `${opts.stamp}.jsonl.gz`), {
          source: "gmgn-openapi",
          requestKey: `wallet_activity:${wallet}`,
          request: { wallet },
          response: page,
        });
          rows.push(...page.activities);
        }
      }
      const ours = await wh.read<TradeRow>("trades", `wallet = ${lit(wallet)}`);
      checks.push(compareWallet(wallet, ours, rows, since));
    } catch (e) {
      errors.push({ wallet, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const summary = summarizeChecks(checks);
  const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
  const lines = [
    "# R0: our trades against GMGN",
    "",
    `${summary.wallets} wallets · our SOL-quoted trades ${summary.ours} · GMGN trades in the same window ${summary.gmgn} · ${gmgn.requests} requests`,
    "",
    "| Check | Result | Threshold |",
    "| --- | --- | --- |",
    `| Our trades found in GMGN | ${pct(summary.coverage)} | ≥ ${THRESHOLDS.coverage * 100}% |`,
    `| Same side | ${pct(summary.side)} | ≥ ${THRESHOLDS.side * 100}% |`,
    `| Same token amount, or apart by a token-side fee ≤ ${MAX_TOKEN_FEE * 100}% | ${pct(summary.tokens)} (exact ${pct(summary.tokens_exact)}) | ≥ ${THRESHOLDS.tokens * 100}% |`,
    "",
    `**${summary.pass ? "Pass" : "Fail"}.**`,
    "",
    "How to read the gaps:",
    "",
    `- GMGN reports the pool's side of a swap; we report what left and reached the wallet. A token fee taken by a launchpad or bot (1% and 3% are common) shows as a gap of that size; SOL gaps are bot fees and are shown for information only.`,
    `- Of our SOL-quoted trades, GMGN also quotes ${pct(summary.quote)} in SOL. The rest are ones where GMGN saw another token (or a stablecoin) as the other side.`,
    `- Stablecoin-quoted trades are counted apart: GMGN found ${pct(summary.stable_coverage)} of our ${summary.ours_stable}.`,
    `- GMGN-only trades: ${summary.gmgn_only}, of which ${summary.gmgn_only_multi_token} come from transactions where several tokens were swapped at once. We record those as complex (cost unknown), not trades.`,
    "",
    "| Wallet | Ours | GMGN | Found | Side | SOL quote | Tokens (exact) | Stable found | GMGN only (multi-token) | SOL median gap |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...checks.map(
      (c) =>
        `| ${c.wallet.slice(0, 6)}… | ${c.ours} | ${c.gmgn} | ${pct(c.ours ? c.matched / c.ours : null)} | ${pct(c.matched ? c.side_agree / c.matched : null)} | ${pct(c.matched ? c.quote_agree / c.matched : null)} | ${pct(c.side_agree ? (c.tokens_exact + c.tokens_fee) / c.side_agree : null)} (${pct(c.side_agree ? c.tokens_exact / c.side_agree : null)}) | ${c.matched_stable}/${c.ours_stable} | ${c.gmgn_only} (${c.gmgn_only_multi_token}) | ${pct(c.sol_median_diff)} |`,
    ),
    ...(errors.length ? ["", "Errors:", ...errors.map((e) => `- ${e.wallet}: ${e.message}`)] : []),
    "",
  ];
  mkdirSync(path.dirname(opts.reportFile), { recursive: true });
  writeFileSync(opts.reportFile, lines.join("\n"));
  return { ...summary, errors, report: opts.reportFile, requests: gmgn.requests, rate_limited: gmgn.rateLimited };
}
