// The daily jobs, in the order they run:
// fetch → ingest → repair → tokens → snapshots → reconcile → check.
//
// Every wallet is handled on its own: one failing wallet is recorded and
// skipped (its cursor does not move), the rest carry on. Writes happen under
// the warehouse write lock and re-read what they change, so the page and the
// CLI can act at the same time without losing updates.

import { runChecks } from "./check";
import { TOKEN_PROGRAMS } from "./constants";
import { litList } from "./db";
import type { DuneClient } from "./dune";
import { build } from "./fifo";
import { type HeliusClient, PARSED_EVENTS_CREDITS, RPC_CREDITS, rawTransaction } from "./helius";
import { historyDir, parseWallet, rawTransactions, rpcDir, type TradeRow, type TransferRow } from "./ingest";
import { accountKeys } from "./normalize";
import { appendRaw } from "./rawStore";
import { compareBalances, derivedBalances, type ReconciliationRow, summarize } from "./reconcile";
import { changedFrom, dayOf, maintainSnapshots, markDirty } from "./snapshots";
import type { Warehouse } from "./store";
import { syncTokens } from "./tokens";
import { dueWallets, loadWallets, markIngested, pendingIngest, recordFetch } from "./wallets";

const DAY = 86_400;
export const BACKFILL_DAYS = 180;
// Re-read a little before the cursor so a transaction confirmed late is not
// skipped; ingest drops the duplicates.
const OVERLAP_SECONDS = 600;
// A batch's trades are held in memory as objects; keep it modest.
const INGEST_BATCH = 10;
export const DEFAULT_CREDIT_BUDGET = 200_000;
const FETCH_CONCURRENCY = 4;

export interface JobError {
  step: string;
  wallet: string | null;
  message: string;
}

type Rows = Record<string, unknown>[];
const asRows = (rows: readonly object[]) => rows as unknown as Rows;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function stampOf(now: number): string {
  return new Date(now * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export { dayOf };

/** Pull new history for each wallet into the raw store and move its cursor. */
export async function fetchWallets(
  wh: Warehouse,
  helius: HeliusClient,
  rawDir: string,
  addresses: readonly string[],
  opts: { now: number; stamp: string; backfillDays?: number; creditBudget?: number; concurrency?: number },
) {
  const cursors = new Map((await loadWallets(wh)).map((w) => [w.address, w.fetch_cursor_time]));
  const budget = opts.creditBudget ?? DEFAULT_CREDIT_BUDGET;
  const start = helius.credits;
  const fetched: Record<string, { txs: number; refetched: number; credits: number }> = {};
  const errors: JobError[] = [];
  const skipped: string[] = [];
  // The budget is checked before each wallet starts, so it can be overshot by
  // the wallets already in flight; stopping one halfway would waste its pages.
  const one = async (address: string) => {
    if (helius.credits - start >= budget) {
      skipped.push(address); // still due next run
      return;
    }
    const cursor = cursors.get(address) ?? null;
    const since = cursor !== null ? cursor - OVERLAP_SECONDS : opts.now - (opts.backfillDays ?? BACKFILL_DAYS) * DAY;
    let credits = 0;
    try {
      let newest: number | null = null;
      let txs = 0;
      const unreadable: string[] = [];
      for await (const { request, response } of helius.transactionHistory(address, { timeGte: since })) {
        credits += PARSED_EVENTS_CREDITS;
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
        credits += RPC_CREDITS;
        appendRaw(`${rpcDir(rawDir, address)}/${opts.stamp}.jsonl.gz`, {
          source: "helius-rpc",
          requestKey: `getTransaction:${sig}`,
          request: { signature: sig },
          response: await helius.getTransaction(sig),
        });
      }
      // Saved per wallet, so a crash halfway keeps what was already fetched.
      await recordFetch(wh, { [address]: [newest, opts.now, since] });
      fetched[address] = { txs, refetched: unreadable.length, credits };
    } catch (e) {
      // Pages already appended stay in raw; the cursor stays put, so the next
      // run fetches the same window again and ingest drops the duplicates.
      errors.push({ step: "fetch", wallet: address, message: message(e) });
    }
  };
  // A few wallets at a time: each page waits on the network, so running them
  // side by side fills the rate limit that a single wallet leaves idle.
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) await one(addresses[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? FETCH_CONCURRENCY) }, worker));
  return { fetched, errors, skipped, credits: helius.credits - start };
}

// Only the fields metrics depend on: a row that differs elsewhere (programs,
// price, ingested_at) does not make a snapshot stale.
const tradeSig = (t: TradeRow) =>
  [t.tx_sig, t.mint, t.side, t.token_amount_raw, t.sol_lamports, t.fee_lamports, t.slot, t.tx_index, t.block_time].join("|");
const transferSig = (x: TransferRow) =>
  [x.tx_sig, x.mint, x.direction, x.token_amount_raw, x.slot, x.tx_index, x.block_time].join("|");

/**
 * Re-parse these wallets from raw and rebuild their trades, transfers, lots and
 * positions. Rows that changed mark the wallet's later snapshots stale; the
 * wallet counts as ingested only once all four tables are written.
 */
export async function ingestWallets(wh: Warehouse, rawDir: string, addresses: readonly string[], now: number) {
  const counts = { trades: 0, token_transfers: 0, lots: 0, positions: 0, stale_wallets: 0 };
  for (let i = 0; i < addresses.length; i += INGEST_BATCH) {
    const batch = addresses.slice(i, i + INGEST_BATCH);
    await wh.locked(async () => {
      const trades: TradeRow[] = [];
      const transfers: TransferRow[] = [];
      for (const a of batch) {
        const parsed = parseWallet(rawDir, a, now);
        trades.push(...parsed.trades);
        transfers.push(...parsed.transfers);
      }
      const where = `wallet IN (${litList(batch)})`;
      const [oldTrades, oldTransfers] = await Promise.all([
        wh.read<TradeRow>("trades", where),
        wh.read<TransferRow>("token_transfers", where),
      ]);
      const stale = changedFrom(oldTrades, trades, tradeSig);
      for (const [w, t] of changedFrom(oldTransfers, transfers, transferSig)) {
        stale.set(w, Math.min(stale.get(w) ?? t, t));
      }
      const { lots, positions } = build(trades, transfers);
      const tables = { trades, token_transfers: transfers, lots, positions } as const;
      for (const [table, rows] of Object.entries(tables) as [keyof typeof tables, object[]][]) {
        await wh.replaceWallets(table, batch, asRows(rows));
        counts[table] += rows.length;
      }
      await markDirty(wh, stale);
      await markIngested(wh, batch, now);
      counts.stale_wallets += stale.size;
    });
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
  opts: { now: number; stamp: string; creditBudget?: number },
) {
  const historyFrom = new Map((await loadWallets(wh)).map((w) => [w.address, w.history_from]));
  const derived = await derivedFor(wh, addresses);
  const known = new Map(
    (await wh.read<TokenAccountState>("token_accounts")).map((r) => [`${r.wallet} ${r.pubkey}`, r]),
  );
  const budget = opts.creditBudget ?? DEFAULT_CREDIT_BUDGET;
  const start = helius.credits;
  const updates = new Map<string, TokenAccountState>();
  const errors: JobError[] = [];
  const touched: string[] = [];
  let mismatched = 0;
  for (const a of addresses) {
    if (helius.credits - start >= budget) break;
    try {
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
        const cursor = known.get(`${a} ${pubkey}`)?.cursor_time ?? null;
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
        updates.set(`${a} ${pubkey}`, {
          wallet: a,
          mint,
          pubkey,
          cursor_time: newest ?? since,
          last_fetched_at: opts.now,
        });
      }
      touched.push(a);
    } catch (e) {
      errors.push({ step: "repair", wallet: a, message: message(e) });
    }
  }
  if (updates.size) {
    await wh.locked(async () => {
      const current = new Map(
        (await wh.read<TokenAccountState>("token_accounts")).map((r) => [`${r.wallet} ${r.pubkey}`, r]),
      );
      for (const [k, v] of updates) current.set(k, v);
      await wh.write("token_accounts", asRows([...current.values()]));
    });
  }
  if (touched.length) await ingestWallets(wh, rawDir, touched, opts.now);
  return {
    wallets_repaired: touched.length,
    mints_mismatched: mismatched,
    token_accounts_fetched: updates.size,
    credits: helius.credits - start,
    errors,
  };
}

async function tokenCreatedAt(wh: Warehouse): Promise<Map<string, number | null> | undefined> {
  if (!wh.files("tokens").length) return undefined;
  const rows = await wh.read<{ mint: string; created_at: number | null }>("tokens");
  return new Map(rows.map((r) => [r.mint, r.created_at]));
}

/** Compare derived balances with the chain and append the result. */
export async function reconcileWallets(
  wh: Warehouse,
  helius: HeliusClient,
  addresses: readonly string[],
  now: number,
): Promise<{ rows: ReconciliationRow[]; errors: JobError[] }> {
  const historyFrom = new Map((await loadWallets(wh)).map((w) => [w.address, w.history_from]));
  const derived = await derivedFor(wh, addresses);
  const tokens = await tokenCreatedAt(wh);
  const rows: ReconciliationRow[] = [];
  const errors: JobError[] = [];
  for (const a of addresses) {
    try {
      const onchain = await helius.tokenBalances(a, TOKEN_PROGRAMS);
      rows.push(
        ...compareBalances(a, derived, onchain, { checkedAt: now, windowStart: historyFrom.get(a) ?? now, tokens }),
      );
    } catch (e) {
      errors.push({ step: "reconcile", wallet: a, message: message(e) });
    }
  }
  await wh.locked(async () => {
    await wh.write("reconciliation", [...(await wh.read("reconciliation")), ...asRows(rows)]);
  });
  return { rows, errors };
}

export function sample<T>(xs: readonly T[], n: number): T[] {
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
  opts: { now: number; dune?: DuneClient | null; reconcileSample?: number; creditBudget?: number },
) {
  const stamp = stampOf(opts.now);
  const errors: JobError[] = [];
  const due = dueWallets(await loadWallets(wh), opts.now);
  const fetch = await fetchWallets(wh, helius, rawDir, due, { now: opts.now, stamp, creditBudget: opts.creditBudget });
  errors.push(...fetch.errors);

  // This run's fetches plus anything an earlier, interrupted run fetched.
  const toIngest = pendingIngest(await loadWallets(wh));
  const ingested = await ingestWallets(wh, rawDir, toIngest, opts.now);

  // Everything ingested this run gets repaired and may be reconciled, including
  // wallets an interrupted run fetched but never got to.
  const repaired = toIngest;
  const repair = await repairWallets(wh, helius, rawDir, repaired, {
    now: opts.now,
    stamp,
    creditBudget: (opts.creditBudget ?? DEFAULT_CREDIT_BUDGET) - fetch.credits,
  });
  errors.push(...repair.errors);

  let tokens: Awaited<ReturnType<typeof syncTokens>> | null = null;
  if (opts.dune) {
    try {
      tokens = await syncTokens(wh, opts.dune, { now: opts.now });
    } catch (e) {
      errors.push({ step: "tokens", wallet: null, message: message(e) });
    }
  }

  const snapshots = await maintainSnapshots(wh, dayOf(opts.now));
  const checked = sample(repaired, opts.reconcileSample ?? 20);
  const recon = await reconcileWallets(wh, helius, checked, opts.now);
  errors.push(...recon.errors);
  const check = await runChecks(wh);
  return {
    as_of_date: dayOf(opts.now),
    due: due.length,
    fetched: Object.keys(fetch.fetched).length,
    skipped_for_budget: fetch.skipped.length,
    ingested: { wallets: toIngest.length, ...ingested },
    repair: { ...repair, errors: repair.errors.length },
    tokens,
    snapshots,
    reconcile: summarize(recon.rows),
    check: { ok: check.ok, failed: check.checks.filter((c) => !c.ok) },
    errors,
    credits: helius.credits,
    rate_limited: helius.rateLimited,
  };
}
