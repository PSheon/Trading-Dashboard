/**
 * How many times a money-path step is tried before it is given up.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */
import { DAY_MS, MINUTE_MS } from './time.js';

/** basis: measured — Hyperliquid's documented minimum order value, 10 USD ("the only exception is exactly closing a position with a reduce-only order")
 * The exchange refuses an order worth less at its limit price; a policy's `minOrderNotionalUsd` can only raise it
 * (copy/min-order-notional.ts), and D7/D8 derive the suggested and the smallest budgets from it.
 */
export const EXCHANGE_MIN_ORDER_NOTIONAL_USD = 10;

/** basis: guessed — three orders per leader leg (the cloid suffix holds one digit); gate 9 records p50/p99 of attempts used
 * A later attempt exists only after the previous one was released as never
 * sent (isDefinitelyUnsent / releaseUnsent); it is a new order with its own
 * cloid, nonce and reservation. The rejected journal is never re-armed.
 */
export const MAX_LIVE_LEG_ATTEMPTS = 3;

/** basis: guessed — a close that keeps failing is refused after 30 attempts; gate 9 records p50/p99
 * A close has no age limit; after this a leader flat closes the rest.
 */
export const CLOSE_ATTEMPT_LIMIT = 30;

/** basis: measured — testnet 2026-10-12: an unsupported mode read right after a setup was the exchange catching up; final on the third read
 */
export const ABSTRACTION_ATTEMPT_LIMIT = 3;

/** basis: guessed — an outbox row is parked after 8 attempts; verify: admin outbox failures
 * Parked as `failed` (visible in admin).
 */
export const MAX_SIGNAL_ATTEMPTS = 8;

/** basis: measured — gate 12 (2026-10-17 04:26–04:32Z): a paper pass of one leader's 200 outbox rows held an owner's
 * copy user lock (7404) 12.0–12.9 s of back-to-back statements (idle ≤ 57 ms), ~1,500 of them at Stage's 8 ms round
 * trip; a live order of that owner waits LIVE_RISK_LOCK_WAIT_MS (1 s) for the same lock and then fails live_risk_busy.
 * Statements a paper signal transaction may send while it holds an owner's lock: 40 × 8 ms = 320 ms on Stage, under
 * half the live wait so a poll's gap fits beside it. test/copy-paper-lock-hold.spec.ts counts them.
 */
export const PAPER_SIGNAL_LOCK_STATEMENT_BUDGET = 40;

/** basis: measured — test/copy-paper-lock-hold.spec.ts (2026-10-17): the statements of a locked paper signal
 * transaction besides its order groups: controls, strategy row, paper check, the legs' one insert, commit.
 */
export const PAPER_SIGNAL_LOCK_FIXED_STATEMENTS = 5;

/** basis: measured — test/copy-paper-lock-hold.spec.ts (2026-10-17): an open order group's statements under the lock
 * (pending sizes, positions ×4, newer-leg check, reservations ×2, user strategies, reduce sizes, order count, the order's
 * paper check and insert, reservation, legs' resolution), the most of any group kind; a close group is five.
 */
export const PAPER_SIGNAL_OPEN_GROUP_STATEMENTS = 16;

/** basis: derived — (PAPER_SIGNAL_LOCK_STATEMENT_BUDGET − PAPER_SIGNAL_LOCK_FIXED_STATEMENTS) ÷ PAPER_SIGNAL_OPEN_GROUP_STATEMENTS, at least one
 * Order groups (one order each, grouped exactly as before) one locked paper signal transaction decides; a strategy's
 * further groups follow in later transactions, LIVE_RISK_LOCK_POLL_MS apart, so a live order's poll can win the lock.
 */
export const PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT = Math.max(1, Math.floor((PAPER_SIGNAL_LOCK_STATEMENT_BUDGET - PAPER_SIGNAL_LOCK_FIXED_STATEMENTS) / PAPER_SIGNAL_OPEN_GROUP_STATEMENTS));

/** basis: guessed — a stop's automatic return is reserved again at most 5 times; verify: return outcomes on Stage
 * Only a return that provably never reached the exchange is reserved again
 * (new nonce), no sooner than sweepRetryDelayMs(n) after attempt n ended.
 */
export const SYSTEM_SWEEP_ATTEMPTS = 5;

/** basis: guessed — 5 Telegram link requests per user per window; verify: none needed
 * Beyond it, 429.
 */
export const LINK_RATE_LIMIT = 5;

/** basis: guessed — … per 10 min; verify: none needed
 */
export const LINK_RATE_WINDOW_MS = 10 * MINUTE_MS;

/** basis: guessed — a leader's recent fills list shows 200; verify: none needed
 */
export const LEADER_FILLS_HISTORY_LIMIT = 200;

/** basis: guessed — a leader's recent alerts list shows 50; verify: none needed
 */
export const LEADER_ALERTS_HISTORY_LIMIT = 50;

/** basis: derived — 30 days (decision D7, 2026-10-23: "近 30 天加倉"), under the 90-day history_fills retention
 * The window of a leader's position-increasing orders whose median notional sizes the suggested minimum budget;
 * it starts at the retention cut instead when that is later (suggested-budget.repository.ts).
 */
export const SUGGESTED_BUDGET_WINDOW_MS = 30 * DAY_MS;

/** basis: guessed — fewer than 5 adds in the window is no sample: suggested = null, no pill; verify: Stage counts how many copied leaders carry a suggestion after a week
 */
export const SUGGESTED_BUDGET_MIN_ADDS = 5;

/** basis: derived — DAY_MS: an equity snapshot older than a day (the scheduler writes one every 5 min for a watched leader) is not this leader's equity any more
 * The suggestion then falls back to the leaderboard's or the pool's account value, else null.
 */
export const SUGGESTED_BUDGET_EQUITY_MAX_AGE_MS = DAY_MS;

/** basis: guessed — Paul 2026-10-23 (decision D8): "交易所最低額＋手續費緩衝（約 12 USD）", so 2 USD over the 10 USD order minimum; verify: Stage records budget_below_exchange_minimum refusals and the smallest budget that completed an open and its close
 * The buffer covers taker fees and the IOC slippage of one minimum-sized order and its close.
 */
export const LIVE_BUDGET_FEE_BUFFER_USD = 2;

/** basis: derived — EXCHANGE_MIN_ORDER_NOTIONAL_USD + LIVE_BUDGET_FEE_BUFFER_USD
 * The smallest budget an actual copy may start with (decision D8): below it a copy could never place one order,
 * so the start is refused `budget_below_exchange_minimum`. A budget under the leader's suggested minimum (D7) is
 * allowed, with a warning pill only.
 */
export const LIVE_BUDGET_MIN_USD = EXCHANGE_MIN_ORDER_NOTIONAL_USD + LIVE_BUDGET_FEE_BUFFER_USD;

/** basis: measured — Stage 2026-10-24: tracked leaders' 30-day fill counts are heavy-tailed; ordinary ones hold 164 and 511 fills, the third target (a market maker, kept tracked) 806,756, and a 100-leader statement over them never finished under the 15 s statement timeout
 * A leader with more fills than this in the window is read through the newest this-many fills only (one bounded
 * index scan on `(account_id, time)`), its median computed over them and its row marked `sampled`: an
 * order-of-magnitude budget needs no more. A leader under the cap is read whole (suggested-budget.repository.ts).
 */
export const SUGGESTED_BUDGET_FILLS_CAP = 100_000;

/** basis: guessed — 20 min of database time an hourly tick: 1,134 Stage targets (1,025 with history) at the ordinary leader's few ms a statement finish in seconds, and even a run of 1 s a leader completes in one tick; verify: the hourly log's leaders, remaining and ms on Stage
 * The suggested-budget refresh reads one leader a statement until this much time has passed, then stops and the
 * next hourly tick continues from the leader it stopped at (it always reads at least one), so a slow database
 * never holds the read worker's pool for the whole hour.
 */
export const SUGGESTED_BUDGET_RUN_BUDGET_MS = 20 * MINUTE_MS;
