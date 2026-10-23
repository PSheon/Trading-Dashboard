/**
 * The clocks of the live copy path: the evidence clock, skew, step budgets, retries and margins.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';
import { INDEX_LAG_MS } from './background.js';

/** basis: guessed — exchange evidence (positions, orders, a mode) is used within 5 s of its read (2026-10-09, three reads take ~4 s at 8 ms RTT); verify: gate 9 evidence age p99
 */
export const LIVE_EVIDENCE_MAX_AGE_MS = 5_000;

/** basis: guessed — twice the mainnet window: testnet lists 273 perp dexes (mainnet 11), its dex fan-out alone took 1.5–1.6 s and order evidence 4.7–5.1 s (gate 11, 2026-10-16); verify: gate 11 records judged evidence p50/p99 under the window in force
 * The ceiling of COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS, the testnet-only
 * evidence window (config/live-evidence-window.ts). Mainnet is always
 * LIVE_EVIDENCE_MAX_AGE_MS: startup refuses the setting on a mainnet deployment.
 */
export const LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS = 2 * LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: measured — the skew monitor on Stage read 3.5 s before sampling at frame arrival and under 1 s after (2026-10-13)
 * How far our clock and Hyperliquid's may disagree before a provider
 * timestamp comparison fails (closed): a provider "not after now" time may
 * be this far ahead of ours; a follower fill's `time` this far before the
 * journal's `createdAt`. The skew monitor warns from 1 s and alerts above it.
 */
export const PROVIDER_CLOCK_SKEW_MS = 2000;

/** basis: derived — half of PROVIDER_CLOCK_SKEW_MS: warn before a comparison fails
 */
export const CLOCK_SKEW_WARN_MS = PROVIDER_CLOCK_SKEW_MS / 2;

/** basis: derived — three of the Privy client's 10 s request timeouts end to end; inside the consent's and nonce's five-minute windows (gate 8)
 * How old a Privy identity proof (wallet, policy, key quorum) may be when a
 * setup decision rests on it, from its first read. Not the exchange's 5 s:
 * these identities change only by an explicit owner/admin action, and Privy
 * enforces the current policy at every signature anyway. A proof is up to a
 * dozen Privy calls, so 5 s failed every pass on a slow link (gate 8,
 * 2026-10-13: `agent_identity_evidence_expired`).
 */
export const PRIVY_IDENTITY_MAX_AGE_MS = 30_000;

/** basis: copied — the exchange evidence's 5 s, kept as the log threshold for a slow identity proof
 * A slower identity proof is logged with its spans.
 */
export const SLOW_IDENTITY_PROOF_MS = LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: guessed — a read inside a running 5 s clock waits at most a second for the shared meter; verify: gate 9 in-window waits
 */
export const IN_WINDOW_METER_WAIT_MS = 1_000;

/** basis: guessed — one driver holds a setup for a minute; verify: gate 9 step duration p99 under the lease
 */
export const SETUP_LEASE_MS = 60_000;

/** basis: guessed — a setup step's client waits up to 15 s in line for its weight; verify: gate 9 reserve waits
 */
export const SETUP_RESERVE_WAIT_MS = 15_000;

/** basis: guessed — the Privy signature's budget, 30 s; verify: gate 9 signer latency p99
 */
export const SETUP_SIGN_MS = 30_000;

/** basis: guessed — the exchange POST's budget, 10 s; verify: gate 9 POST latency p99
 */
export const SETUP_POST_MS = 10_000;

/** basis: guessed — long setup work answers with its row after 10 s; verify: none needed (HTTP contract)
 */
export const SETUP_ANSWER_MS = 10_000;

/** basis: measured — Stage 2026-10-11: dropped confirms cost the owner another signature; 30 s outwaits a driver's pass
 */
export const SETUP_CONFIRM_LEASE_WAIT_MS = 30_000;

/** basis: guessed — a step waiting on what it started looks again in 3 s; verify: gate 9 pending waits
 */
export const SETUP_RETRY_PENDING_MS = 3_000;

/** basis: guessed — no worker signer yet: look again in 15 s; verify: none needed
 */
export const SETUP_RETRY_SIGNER_UNAVAILABLE_MS = 15_000;

/** basis: guessed — a transient setup failure backs off from 3 s; verify: gate 9 retry outcomes by attempt
 */
export const SETUP_RETRY_BACKOFF_BASE_MS = 3_000;

/** basis: guessed — the back-off caps at a minute; verify: gate 9 retry outcomes by attempt
 */
export const SETUP_RETRY_BACKOFF_MAX_MS = 60_000;

/** basis: guessed — eight transient attempts (about four minutes) before a real-money setup ends (handoff 2026-10-11 said 3; 3 ended it in 9 s); verify: gate 9
 */
export const SETUP_RETRY_TRANSIENT_ATTEMPTS = 8;

/** basis: guessed — a step waiting for its owner is looked at every 15 s; verify: none needed
 */
export const SETUP_RETRY_NEEDS_OWNER_MS = 15_000;

/** basis: guessed — expiring agents, liquidations and unfinished close-alls are looked for every minute; verify: none needed
 */
export const STOP_SYSTEM_CHECK_MS = 60_000;

/** basis: guessed — a copy is stopped a day before its agent expires: room for closes, retries and the return; verify: stop duration p99 on Stage
 */
export const AGENT_EXPIRY_STOP_MARGIN_MS = DAY_MS;

/** basis: guessed — a single-position close gives up after 10 orders; verify: gate 9 close attempts
 */
export const STOP_CLOSE_ATTEMPTS = 10;

/** basis: guessed — a tracked resting order's cancel gives up after 3 attempts; verify: gate 9
 */
export const STOP_CANCEL_ATTEMPTS = 3;

/** basis: derived — a try-lock is held for one order's evidence and POST, a few seconds; back in one
 * Retry delay when another order, stop or settlement of the same account
 * holds its live-risk try-lock.
 */
export const LIVE_RISK_BUSY_RETRY_MS = 1_000;

/** basis: measured — gate 11 lock sampler (2026-10-16, f3c2f9ba): the user lock's by-design holders, a settlement's scope (≤ 330 ms, p50 26) and an order's (≤ 267 ms, p50 19); 1 s covers the longest three times over
 * How long a live-risk scope tries its exclusive locks (user, account) again
 * before answering live_risk_busy: a scope held for a few hundred ms by
 * another order or a settlement no longer fails the attempt (the order's
 * next try was a second later and its signal had expired after three).
 * Nothing is read or reserved while it waits; LIVE_RISK_LOCK_POLL_MS apart.
 */
export const LIVE_RISK_LOCK_WAIT_MS = 1_000;

/** basis: derived — LIVE_RISK_LOCK_WAIT_MS / 10: ten tries, each one round trip (8 ms on Stage)
 */
export const LIVE_RISK_LOCK_POLL_MS = LIVE_RISK_LOCK_WAIT_MS / 10;

/** basis: measured — local harness 2026-10-12: a burst of failed reads used up the 30 WebSocket connects a minute
 * Retry delay for a failed provider read (PROVIDER_READ_FAILURES, a meter
 * refusal): it opened a socket or spent weight.
 */
export const PROVIDER_READ_RETRY_MS = 10_000;

/** basis: guessed — no live step is retried within a second of a wait; verify: none needed
 * Whatever the error's hint: a sub-second retry of a real-money step only spins.
 */
export const WAIT_FLOOR_MS = 1_000;

/** basis: guessed — a leg's and a stop's failed step is tried again in 3 s, flat; verify: gate 9 records p50/p99
 */
export const LIVE_LEG_RETRY_BASE_MS = 3_000;

/** basis: guessed — a setup's claim wait is logged with the meter at most every 5 s; verify: none needed
 * A setup's claim waits are logged with the meter's composition at most this often.
 */
export const SETUP_CLAIM_LOG_EVERY_MS = 5_000;

/** basis: measured — a local setup reached revision 12716 in 14 h polling its credit every pass (2026-10-12)
 * Cap on pendingMs × 2^(waits − 1) between credit checks, so an unreachable
 * explorer is not polled every pass. Only the credit resets it.
 */
export const AWAITING_CREDIT_MAX_WAIT_MS = 60_000;

/** basis: derived — an approval's nonce can't land later than Hyperliquid's two-day nonce window; three days covers it
 */
export const ABANDONED_APPROVAL_WINDOW_MS = 3 * DAY_MS;

/** basis: guessed — a refund that never left is tried again after two minutes; verify: abort durations on Stage
 */
export const NOT_DISPATCHED_RETRY_MS = 120_000;

/** basis: guessed — a flat proof older than 2.5 s is taken again before the refund is signed; verify: none needed
 */
export const REPROVE_AFTER_MS = 2_500;

/** basis: guessed — a copy account still not flat 30 min into its abort is the owner's; verify: abort outcomes on Stage
 * Then setup_abort_not_flat_persistent / needs_owner. Measured from the
 * row's backoff.notFlatSince; a flat proof resets it.
 */
export const SETUP_ABORT_NOT_FLAT_ESCALATE_MS = 30 * MINUTE_MS;

/** basis: guessed — a blocked abort is looked at every 5 min, not every pass; verify: none needed
 * It waits for someone's action. Re-deferring the same block writes nothing
 * (repository.defer: no revision, no updatedAt).
 */
export const SETUP_ABORT_BLOCKED_RECHECK_MS = 5 * MINUTE_MS;

/** basis: guessed — the shared all-venue source serves one read a second; verify: gate 9 absence-proof socket timing
 */
export const SOURCE_SPACING_MS = 1_000;

/** basis: guessed — a flat close that had to wait observes the account again after 10 s; verify: none needed
 * It waited on a leg of the coin in flight or busy risk locks; each
 * observation is a provider read.
 */
export const FLAT_CARRY_RETRY_MS = 10_000;

/** basis: guessed — a pending admin revoke is bounded at 30 min by default (COPY_LIVE_REVOKE_DEADLINE_MINUTES); verify: none needed
 */
export const REVOKE_DEADLINE_MS = 30 * MINUTE_MS;

/** basis: guessed — a feed trade REST hasn't returned a minute later no longer holds coverage back; verify: fast-source audit misses on Stage
 * The after-sweep audit then reports the fill the stream missed.
 */
export const WITNESS_EXPIRY_MS = 60_000;

/** basis: measured — the mainnet fill index trails the exchange by up to this (p99.9, the fast source's design measurement); the default of COPY_LIVE_FAST_SOURCE_GRACE_MS
 * G: a fast-source read certifies fills only up to this long before it was
 * sent, and a leader's reads come no closer than this (FAST_SOURCE_LEADER_WEIGHT).
 */
export const FAST_SOURCE_GRACE_MS = 2000;

/** basis: guessed — 100 ms of timer slack (626a4524, 2026-10-06): the read a kick sends certifies up to `sentAt − G`, which must reach the witnessed trade's exchange time when the timer fires early or the clocks round; verify: fast-source audit misses on Stage (a witnessed trade the read stopped short of)
 * Added to G when FastMainnetSource schedules the read for a witnessed trade
 * (`witness`, `followUp`).
 */
export const WITNESS_MARGIN_MS = 100;

/** basis: guessed — 626a4524 (2026-10-06): while the trade feed is down the pass reads each fast-source leader every 7.5 s (8 reads a minute, ~170 weight, inside FAST_SOURCE_LEADER_WEIGHT); verify: feed-down reads per leader per minute on Stage
 * The engine's `fastPollMs` default: the least time between two pass reads of
 * a fast-source leader while no kicks come.
 */
export const FAST_SOURCE_FEED_DOWN_POLL_MS = 7_500;

/** basis: guessed — 72f586ff (2026-10-06): on Stage the fast-source leader's kicks (~3.5 fills a minute plus follow-ups) never let the pass run; a kick's order half starts no work after 8 s; verify: kick duration p50/p99 on Stage
 * The engine's `kickBudgetMs` default; the leader's remaining legs wait for the pass.
 */
export const KICK_BUDGET_MS = 8_000;

/** basis: guessed — cd36049c (2026-10-04): a worker pass starts no more work after 20 s, so the next pass (COPY_LIVE_INTERVAL_MS 3 s) is not held up; verify: pass duration p99 on Stage
 * The engine's `passBudgetMs` default.
 */
export const PASS_BUDGET_MS = 20_000;

/** basis: guessed — cd36049c (2026-10-04): a mainnet source read stops 1 s before now, so the watcher's frames can confirm the fills it reads; verify: watched-source verification lag on Stage
 * The engine's `sourceLagMs` default.
 */
export const SOURCE_LAG_MS = 1_000;

/** basis: guessed — cd36049c (2026-10-04): a testnet leader is read from REST once a minute (two worst-case 120-weight reads per stream); verify: none needed (Stage copies mainnet leaders; the harness sets 3 s)
 * The default of COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS (runtime-config) and of
 * the engine's `testnetSourceIntervalMs`; TESTNET_SOURCE_RETRY_MS doubles up to it.
 */
export const TESTNET_SOURCE_INTERVAL_MS = 60_000;

/** basis: derived — WITNESS_EXPIRY_MS: a fast read that left its stream in gap is followed up for as long as a feed trade REST hasn't returned is
 * After it the pass's reads (the watched source, the feed-down poll) are the stream's way back; a follow-up that
 * kept firing on a stream nobody reads again (quarantined, its last copy gone) span a 0 ms timer until restart
 * (review of c888f6c5, 2026-10-23).
 */
export const GAP_FOLLOW_UP_EXPIRY_MS = WITNESS_EXPIRY_MS;

/** basis: guessed — follow-up reads of one leader start a second apart (never closer than G: FAST_SOURCE_GRACE_MS); verify: fast-source follow-up histogram
 * Doubles while a witnessed trade stays missing.
 */
export const FOLLOW_UP_MIN_MS = 1000;

/** basis: guessed — … doubling to 8 s; verify: fast-source follow-up histogram
 */
export const FOLLOW_UP_MAX_MS = 8000;

/** basis: measured — evidence reads take ~4 s; a merged order is planned within 15 s of its legs
 * No leg is merged older than the signal age less this.
 */
export const PLANNING_MARGIN_MS = 15_000;

/** basis: guessed — a below-minimum open keeps waiting only with 30 s of signal left; verify: gate 9 held opens
 * With less left, it is refused.
 */
export const HOLD_MARGIN_MS = 30_000;

/** basis: guessed — a second of the evidence clock kept for a close's own checks (was SNAPSHOT_MAX_AGE_MS = LIVE_EVIDENCE_MAX_AGE_MS − 1 s); verify: gate 9 close evidence age
 * A close reuses its held snapshot while it is at most the evidence window
 * minus this old (liveSnapshotMaxAgeMs, config/live-evidence-window.ts).
 */
export const SNAPSHOT_CHECK_MARGIN_MS = 1_000;

/** basis: guessed — an up-front weight reservation takes at most 10 s when the budget sets no bound; verify: none needed
 */
export const RESERVE_BOUND_MS = 10_000;

/** basis: copied — the 5 s evidence clock, as how long an order approval is reused within one execution
 * SQL grant reads and POST freshness checks still run every time.
 */
export const APPROVAL_REUSE_MS = LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: guessed — an answered lock check answers the next assertHeld for 50 ms; verify: none needed
 * Only with no statement on the session since (`lockCheck`).
 */
export const LOCK_CHECK_REUSE_MS = 50;

/** basis: guessed — a `submitting` order older than 30 s is resumed after a restart; verify: none needed
 */
export const SUBMITTING_RECOVERY_MS = 30_000;

/** basis: guessed — a close-all the api didn't finish is resumed by the worker after a minute; verify: none needed
 */
export const CLOSE_ALL_RESUME_AFTER_MS = 60_000;

/** basis: derived — a minute of the nonce's five-minute window left to sign and send
 */
export const SETUP_NONCE_MIN_REMAINING_MS = 60_000;

/** basis: measured — Hyperliquid's signed-action window is five minutes
 */
export const RETURN_CONSENT_WINDOW_MS = 5 * MINUTE_MS;

/** basis: measured — Hyperliquid docs: a nonce may be up to one day ahead of block time
 */
export const FUNDING_NONCE_SKEW_MS = DAY_MS;

/** basis: measured — Hyperliquid docs: nonces must be within (T − 2 days, T + 1 day); an hour of margin
 * A transfer signed with an older nonce can no longer execute.
 */
export const FUNDING_NONCE_EXPIRY_MS = 2 * DAY_MS + HOUR_MS;

/** basis: derived — FUNDING_NONCE_EXPIRY_MS less a day and its hour of margin: a setup's reserved deposit is
 * re-reserved once its nonce is a day old, so the deposit the owner signs always has a day left to execute
 * (copy-live-setup-provisioning.ts). The margin is intentional: a setup may wait on the owner for hours.
 */
export const SETUP_DEPOSIT_NONCE_REFRESH_MS = FUNDING_NONCE_EXPIRY_MS - DAY_MS - HOUR_MS;

/** basis: guessed — an order request may be on its way for 20 s (the transport's HTTP timeout); gate 9 records p50/p99
 */
export const LIVE_HTTP_TIMEOUT_MS = 20_000;

/** basis: guessed — this machine's clock may run a minute ahead of the exchange's; gate 9 records the skew monitor
 */
export const LIVE_CLOCK_SKEW_ALLOWANCE_MS = 60_000;

/** basis: derived — LIVE_HTTP_TIMEOUT_MS + LIVE_CLOCK_SKEW_ALLOWANCE_MS (was 30 s: less than both)
 * Past expiresAfter by more than this, an order unknown by cloid can no
 * longer be in flight or accepted late.
 */
export const NEVER_PLACED_GRACE_MS = LIVE_HTTP_TIMEOUT_MS + LIVE_CLOCK_SKEW_ALLOWANCE_MS;

/** basis: derived — INDEX_LAG_MS (fill index lag, measured p90 1.5 s, a minute of margin) + LIVE_EVIDENCE_MAX_AGE_MS (our clock ahead of the exchange's, as far as the certificate's own account snapshot allows): 65 s (was 80 s)
 * How far past a cancel the fill scan (`to = now`) must reach before its
 * booked fills stand for an unacknowledged IOC's filled quantity. Two things
 * hide a fill from a scan that reached it: the fill index trailing the
 * exchange (INDEX_LAG_MS), and our clock running ahead of the exchange's,
 * bounded by the certificate's freshProvider snapshot. A request in flight is
 * not a term (the provider reads its index on arrival). A fill booked after
 * release still quarantines the account (copy-follower-ledger.ts).
 * The mainnet value; the live path reads liveFillScanMarginMs
 * (config/live-evidence-window.ts), which follows the evidence window in force.
 */
export const LIVE_FILL_SCAN_MARGIN_MS = INDEX_LAG_MS + LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: derived — the shared mainnet mids read is cached 3 s; 10 s bounds a reference older than the 5 s frames
 */
export const SOURCE_MID_MAX_AGE_MS = 10_000;

/** basis: derived — leader capital is the paper sizing's 60 s cache; 120 s bounds it
 */
export const SOURCE_EQUITY_MAX_AGE_MS = 120_000;

/** basis: guessed — one rejected 60 s testnet source read cost gate run 9 a trade (2026-10-14); verify: gate 10 records source retry delays
 * Doubles per consecutive failed or incomplete read, capped at
 * COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS; a budget wait's later deadline wins.
 */
export const TESTNET_SOURCE_RETRY_MS = 5_000;

/** basis: guessed — the settlement loop retries every 3 s; one line per order per 30 s says why it is still pending without flooding the log (gate run 10, 2026-10-14); verify: the next gate's settlement log
 * Per order (SettlementPendingLog).
 */
export const SETTLEMENT_PENDING_LOG_INTERVAL_MS = 30_000;

/** basis: guessed — the api settlement loop runs every 3 s, so a settlement waits at most this long for its live-demand room and the next pass retries (review of fdbaa269: 65 s let one starved order hold up the rest of the pass); verify: gate 11 settlement claim waits
 * A pass that gives up keeps its claim's place (claimLive keyed by the order): the next pass renews
 * the same claim and its wait goes on, so a need that takes longer than this to free up (gate 11
 * run 6: quoted 15–32 s with every charge living 60 s) is served once it has, never queued behind
 * its own earlier passes.
 */
export const SETTLEMENT_CLAIM_WAIT_MS = 15_000;

/** basis: measured — gate 11 (2026-10-16): a terminal settlement's pass took 3–6 s; the one that could not prove its order failed every pass for 50+ min
 * A failed settlement pass is tried again this long after it (flat; a failed
 * provider read waits PROVIDER_READ_RETRY_MS), not on every 3 s tick: each
 * pass claims live demand and opens the account's sockets.
 */
export const SETTLEMENT_RETRY_MS = 6_000;

/** basis: measured — mainnet evidence probe 2026-10-14 (scripts/copy-harness, 819 fills): the fill index trails the exchange p50 37 ms,
 * p90 722 ms, p99 3.75 s; the settlement pass's own ~150 ms before its receipt scan leaves (claim, record, scan claim at Stage's 8 ms
 * round trip) puts that read past p90. verify: Stage records the share of first settlement passes ending live_settlement_receipts_incomplete
 * After an order's terminal ack the engine wakes its leader's order half this long later (CopyLiveEngine.onWake →
 * CopyLiveWorkerService), so the settlement runs then instead of at the next 3 s pass (COPY_LIVE_INTERVAL_MS) or kick:
 * the local worker log (2026-10-17, gate 14) shows settlements starting 0.5–4.5 s after the ack. Earlier would read the
 * follower's fills before the index has them (live_settlement_receipts_incomplete: a failed pass, SETTLEMENT_RETRY_MS later).
 */
export const SETTLEMENT_WAKE_DELAY_MS = 1_000;

/** basis: derived — SETTLEMENT_RETRY_MS (6 s, 10 s after a failed read) × 10: about 1–1.5 min of failed passes
 * Failed passes (counted by decideRetry: a meter wait is not one) after
 * which a settlement stops retrying: its order is quarantined for its owner
 * (needs_owner) with an ALERT, and nothing claims live demand for it again.
 */
export const SETTLEMENT_RETRY_ATTEMPTS = 10;
