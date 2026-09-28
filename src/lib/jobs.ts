// The daily jobs, in the order they run:
// fetch → ingest → repair → snapshot → reconcile.

import { TOKEN_PROGRAMS } from "./constants";
import { litList } from "./db";
import { build } from "./fifo";
import { type HeliusClient, rawTransaction } from "./helius";
import { historyDir, parseWallet, rawTransactions, rpcDir, type TradeRow, type TransferRow } from "./ingest";
import { compute } from "./metrics";
import { accountKeys } from "./normalize";
import { appendRaw } from "./rawStore";
import { compareBalances, derivedBalances, type ReconciliationRow, summarize } from "./reconcile";
import type { Warehouse } from "./store";
import { dueWallets, loadWallets, recordFetch } from "./wallets";

const DAY = 86_400;
export const BACKFILL_DAYS = 180;
// Re-read a little before the cursor so a transaction confirmed late is not
// skipped; ingest drops the duplicates.
const OVERLAP_SECONDS = 600;
const INGEST_BATCH = 200;

type Rows = Record<string, unknown>[];
const asRows = (rows: readonly object[]) => rows as unknown as Rows;

export function stampOf(now: number): string {
  return new Date(now * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function dayOf(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Pull new history for each wallet into the raw store and move its cursor. */
export async function fetchWallets(
  wh: Warehouse,
  helius: HeliusClient,
  rawDir: string,
  addresses: readonly string[],
  opts: { now: number; stamp: string; backfillDays?: number },
) {
  const cursors = new Map((await loadWallets(wh)).map((w) => [w.address, w.fetch_cursor_time]));
  const out: Record<string, { txs: number; refetched: number; credits: number }> = {};
  for (const address of addresses) {
    const cursor = cursors.get(address) ?? null;
    const since = cursor !== null ? cursor - OVERLAP_SECONDS : opts.now - (opts.backfillDays ?? BACKFILL_DAYS) * DAY;
    const creditsBefore = helius.credits;
    let newest: number | null = null;
    let txs = 0;
    const unreadable: string[] = [];
    for await (const { request, response } of helius.transactionHistory(address, { timeGte: since })) {
      appendRaw(`${historyDir(rawDir, address)}/${opts.stamp}.jsonl.gz`, {
        source: "helius-parsed-events",
        requestKey: `transaction-history:${address}`,
        request,
        response,
      });
      for (const result of response.data ?? []) {
        txs += 1;
        const bt = result.parsed?.blockTime;
        if (bt != null && (newest === null || bt > newest)) newest = bt;
        if (!rawTransaction(result)) unreadable.push(result.signature);
      }
    }
    for (const sig of unreadable) {
      appendRaw(`${rpcDir(rawDir, address)}/${opts.stamp}.jsonl.gz`, {
        source: "helius-rpc",
        requestKey: `getTransaction:${sig}`,
        request: { signature: sig },
        response: await helius.getTransaction(sig),
      });
    }
    // Saved per wallet, so a crash halfway keeps what was already fetched.
    await recordFetch(wh, { [address]: [newest, opts.now, since] });
    out[address] = { txs, refetched: unreadable.length, credits: helius.credits - creditsBefore };
  }
  return out;
}

/** Re-parse these wallets from raw and rebuild their trades, transfers, lots, positions. */
export async function ingestWallets(wh: Warehouse, rawDir: string, addresses: readonly string[], now: number) {
  const counts = { trades: 0, token_transfers: 0, lots: 0, positions: 0 };
  for (let i = 0; i < addresses.length; i += INGEST_BATCH) {
    const batch = addresses.slice(i, i + INGEST_BATCH);
    const trades: TradeRow[] = [];
    const transfers: TransferRow[] = [];
    for (const a of batch) {
      const parsed = parseWallet(rawDir, a, now);
      trades.push(...parsed.trades);
      transfers.push(...parsed.transfers);
    }
    const { lots, positions } = build(trades, transfers);
    const tables = { trades, token_transfers: transfers, lots, positions } as const;
    for (const [table, rows] of Object.entries(tables) as [keyof typeof tables, object[]][]) {
      await wh.replaceWallets(table, batch, asRows(rows));
      counts[table] += rows.length;
    }
  }
  return counts;
}

async function derivedFor(wh: Warehouse, addresses: readonly string[]) {
  const where = `wallet IN (${litList(addresses)})`;
  const [trades, transfers] = await Promise.all([
    wh.read<TradeRow>("trades", where),
    wh.read<TransferRow>("token_transfers", where),
  ]);
  return derivedBalances(trades, transfers);
}

/** {mint: token account addresses} the wallet has owned in transactions we hold. */
function tokenAccountsSeen(rawDir: string, wallet: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { raw } of rawTransactions(rawDir, wallet)) {
    const keys = accountKeys(raw);
    for (const b of [...(raw.meta.preTokenBalances ?? []), ...(raw.meta.postTokenBalances ?? [])]) {
      if (b.owner === wallet && b.accountIndex < keys.length) {
        let s = out.get(b.mint);
        if (!s) out.set(b.mint, (s = new Set()));
        s.add(keys[b.accountIndex]);
      }
    }
  }
  return out;
}

interface TokenAccountState {
  wallet: string;
  mint: string;
  pubkey: string;
  cursor_time: number | null;
  last_fetched_at: number;
}

/**
 * Fetch token-account history for mints whose balance does not reconcile.
 *
 * A wallet's own history misses transactions that only touch one of its token
 * accounts, such as a transfer into an account it already has. For each mint
 * that does not reconcile, pull that account's history into the wallet's raw
 * files and re-ingest. Only mismatches are fetched, so it stays cheap; a
 * per-account cursor keeps a mint held since before our history starts (which
 * never reconciles) from being fetched in full every day.
 */
export async function repairWallets(
  wh: Warehouse,
  helius: HeliusClient,
  rawDir: string,
  addresses: readonly string[],
  opts: { now: number; stamp: string },
) {
  const historyFrom = new Map((await loadWallets(wh)).map((w) => [w.address, w.history_from]));
  const derived = await derivedFor(wh, addresses);
  const state = new Map(
    (await wh.read<TokenAccountState>("token_accounts")).map((r) => [`${r.wallet} ${r.pubkey}`, r]),
  );
  const creditsBefore = helius.credits;
  const touched: string[] = [];
  let mismatched = 0;
  let fetched = 0;
  for (const a of addresses) {
    const accounts = await helius.tokenAccounts(a, TOKEN_PROGRAMS);
    const onchain = new Map<string, bigint>();
    for (const acc of accounts) onchain.set(acc.mint, (onchain.get(acc.mint) ?? 0n) + acc.amount);
    const rows = compareBalances(a, derived, onchain, { checkedAt: opts.now, windowStart: opts.now });
    const bad = new Set(rows.filter((r) => r.diff_raw !== 0n).map((r) => r.mint));
    if (!bad.size) continue;
    mismatched += bad.size;
    const targets = new Map<string, string>();
    for (const acc of accounts) if (bad.has(acc.mint) && acc.pubkey) targets.set(acc.pubkey, acc.mint);
    for (const [mint, pubkeys] of tokenAccountsSeen(rawDir, a)) {
      if (bad.has(mint)) for (const p of pubkeys) targets.set(p, mint);
    }
    for (const [pubkey, mint] of [...targets].sort()) {
      const cursor = state.get(`${a} ${pubkey}`)?.cursor_time ?? null;
      const since = cursor !== null ? cursor - OVERLAP_SECONDS : (historyFrom.get(a) ?? null);
      let newest = cursor;
      for await (const { request, response } of helius.transactionHistory(pubkey, { timeGte: since })) {
        appendRaw(`${historyDir(rawDir, a)}/${opts.stamp}-token-account-${pubkey}.jsonl.gz`, {
          source: "helius-parsed-events",
          requestKey: `transaction-history:${pubkey}`,
          request,
          response,
        });
        for (const result of response.data ?? []) {
          const bt = result.parsed?.blockTime;
          if (bt != null && (newest === null || bt > newest)) newest = bt;
        }
      }
      state.set(`${a} ${pubkey}`, {
        wallet: a,
        mint,
        pubkey,
        cursor_time: newest ?? since,
        last_fetched_at: opts.now,
      });
      fetched += 1;
    }
    touched.push(a);
  }
  if (state.size) await wh.write("token_accounts", asRows([...state.values()]));
  if (touched.length) await ingestWallets(wh, rawDir, touched, opts.now);
  return {
    wallets_repaired: touched.length,
    mints_mismatched: mismatched,
    token_accounts_fetched: fetched,
    credits: helius.credits - creditsBefore,
  };
}

async function tokenCreatedAt(wh: Warehouse): Promise<Map<string, number | null> | undefined> {
  if (!wh.files("tokens").length) return undefined;
  const rows = await wh.read<{ mint: string; created_at: number | null }>("tokens");
  return new Map(rows.map((r) => [r.mint, r.created_at]));
}

/** Write wallet_metrics_daily for one as_of_date. Returns the number of wallets. */
export async function snapshot(wh: Warehouse, day: string): Promise<number> {
  const rows = await compute(day, {
    trades: wh.relation("trades"),
    positions: wh.relation("positions"),
    tokens: wh.files("tokens").length ? wh.relation("tokens") : null,
  });
  await wh.writeDay("wallet_metrics_daily", day, asRows(rows));
  return rows.length;
}

export async function snapshotRange(wh: Warehouse, start: string, end: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY * 1000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out[day] = await snapshot(wh, day);
  }
  return out;
}

/** Compare derived balances with the chain and append the result. */
export async function reconcileWallets(
  wh: Warehouse,
  helius: HeliusClient,
  addresses: readonly string[],
  now: number,
): Promise<ReconciliationRow[]> {
  const historyFrom = new Map((await loadWallets(wh)).map((w) => [w.address, w.history_from]));
  const derived = await derivedFor(wh, addresses);
  const tokens = await tokenCreatedAt(wh);
  const rows: ReconciliationRow[] = [];
  for (const a of addresses) {
    const onchain = await helius.tokenBalances(a, TOKEN_PROGRAMS);
    rows.push(...compareBalances(a, derived, onchain, { checkedAt: now, windowStart: historyFrom.get(a) ?? now, tokens }));
  }
  const existing = await wh.read("reconciliation");
  await wh.write("reconciliation", [...existing, ...asRows(rows)]);
  return rows;
}

function sample<T>(xs: readonly T[], n: number): T[] {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Everything that runs once a day, in order. */
export async function daily(
  wh: Warehouse,
  helius: HeliusClient,
  rawDir: string,
  opts: { now: number; reconcileSample?: number },
) {
  const stamp = stampOf(opts.now);
  const due = dueWallets(await loadWallets(wh), opts.now);
  await fetchWallets(wh, helius, rawDir, due, { now: opts.now, stamp });
  const ingested = await ingestWallets(wh, rawDir, due, opts.now);
  const repair = await repairWallets(wh, helius, rawDir, due, { now: opts.now, stamp });
  const day = dayOf(opts.now);
  const snapshotWallets = await snapshot(wh, day);
  const checked = sample(due, opts.reconcileSample ?? 20);
  const reconcile = summarize(await reconcileWallets(wh, helius, checked, opts.now));
  return {
    as_of_date: day,
    fetched: due.length,
    ingested,
    repair,
    snapshot_wallets: snapshotWallets,
    reconcile,
    credits: helius.credits,
  };
}

