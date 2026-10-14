/**
 * The clocks of the live copy path: the evidence clock, skew, step budgets, retries and margins.
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';
import { INDEX_LAG_MS } from './background.js';

/** basis: guessed — exchange evidence (positions, orders, a mode) is used within 5 s of its read (2026-10-09, three reads take ~4 s at 8 ms RTT); verify: gate 9 evidence age p99
 */
export const LIVE_EVIDENCE_MAX_AGE_MS = 5_000;

/** basis: measured — the skew monitor on Stage read 3.5 s before sampling at frame arrival and under 1 s after (2026-10-13)
 * How far our clock and Hyperliquid's may disagree before a comparison of a
 * provider timestamp with our clock fails. Every such comparison names it:
 * - a provider time "not after now" (account state `time`, a resting order's
 * `timestamp`) may be up to this far ahead of our clock (ours runs behind);
 * - a follower fill's exchange `time` may be up to this far before the order
 * journal's `createdAt` on our clock (ours runs ahead by more than the
 * sign-to-send latency).
 * Above it the comparison still fails (closed); the skew monitor warns from
 * 1 s on, before it matters, and alerts above it.
 */
export const PROVIDER_CLOCK_SKEW_MS = 2000;

/** basis: derived — half of PROVIDER_CLOCK_SKEW_MS: warn before a comparison fails
 * The monitor warns when the measured skew is larger than this.
 */
export const CLOCK_SKEW_WARN_MS = PROVIDER_CLOCK_SKEW_MS / 2;

/** basis: derived — three of the Privy client's 10 s request timeouts end to end; inside the consent's and nonce's five-minute windows (gate 8)
 * How old a Privy identity proof may be when a setup decision rests on it: a
 * wallet's id, address and owner quorum, a policy's content fingerprint, a key
 * quorum's members. Measured from the proof's first read.
 * Not Hyperliquid's 5 s. That bound is for exchange evidence (positions,
 * orders, an agent list, a mode), which changes from one second to the next.
 * These identities are immutable (a wallet's id, address and external id) or
 * change only by an owner's or an admin's explicit action (a policy, a
 * signer, a quorum). Privy also enforces the wallet's current policy and
 * signers at every signature, so an identity that changed after the read
 * still can't sign outside them. The 5 s bound was copied here from the
 * exchange checks (feat(copy) 22f9e963): one proof is up to a dozen Privy
 * HTTPS calls (~0.4–0.5 s each from a developer's link, more on a phone
 * hotspot), so it could not pass at all over a slower link (gate run 8,
 * 2026-10-13 12:51: `agent_identity_evidence_expired` every pass, the agent's
 * approval never recorded).
 * 30 s: the reads now run in parallel (about three round trips on the
 * critical path), so this holds three of the Privy client's 10 s request
 * timeouts end to end, and stays far inside the decisions it guards (a
 * consent's and a nonce's five-minute windows).
 */
export const PRIVY_IDENTITY_MAX_AGE_MS = 30_000;

/** basis: copied — the exchange evidence's 5 s, kept as the log threshold for a slow identity proof
 * An identity proof slower than this is logged with its spans (the bound it
 * had before 2026-10-13, copied from the exchange's evidence checks).
 */
export const SLOW_IDENTITY_PROOF_MS = LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: guessed — a read inside a running 5 s clock waits at most a second for the shared meter; verify: gate 9 in-window waits
 * Longest wait for room in the shared per-IP meter once a 5 s clock runs.
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
 * A copy is stopped this long before its agent expires (one day: room for
 * the stop's closes, retries and return while the agent still signs).
 */
export const AGENT_EXPIRY_STOP_MARGIN_MS = DAY_MS;

/** basis: guessed — a single-position close gives up after 10 orders; verify: gate 9 close attempts
 */
export const STOP_CLOSE_ATTEMPTS = 10;

/** basis: guessed — a tracked resting order's cancel gives up after 3 attempts; verify: gate 9
 */
export const STOP_CANCEL_ATTEMPTS = 3;

/** basis: derived — a try-lock is held for one order's evidence and POST, a few seconds; back in one
 * When a busy live-risk scope (another order, stop or settlement of the
 * same account holds its advisory try-lock) is tried again: it is held for
 * one order's evidence and POST at most, a few seconds.
 */
export const LIVE_RISK_BUSY_RETRY_MS = 1_000;

/** basis: measured — local harness 2026-10-12: a burst of failed reads used up the 30 WebSocket connects a minute
 * A failed provider read (PROVIDER_READ_FAILURES, a meter refusal) is
 * tried again after this: it opened a socket or spent weight, so a burst of
 * retries can't use up the 30 new WebSocket connections a minute.
 */
export const PROVIDER_READ_RETRY_MS = 10_000;

/** basis: guessed — no live step is retried within a second of a wait; verify: none needed
 * No live step is tried again within a second of a wait, whatever the
 * error's hint: a sub-second retry of a real-money step only spins.
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
 * A setup waiting for its deposit's credit looks again after
 * pendingMs × 2^(waits − 1), at most this: an explorer or ledger that can't be
 * reached is not polled every pass (a local setup reached revision 12716 in
 * 14 h, 2026-10-12). Only the credit (the stage moving on) resets it.
 */
export const AWAITING_CREDIT_MAX_WAIT_MS = 60_000;

/** basis: derived — an approval's nonce can't land later than Hyperliquid's two-day nonce window; three days covers it
 * How long after its setup ended an approval left unknown is still looked at.
 */
export const ABANDONED_APPROVAL_WINDOW_MS = 3 * DAY_MS;

/** basis: guessed — a refund that never left is tried again after two minutes; verify: abort durations on Stage
 * A refund that never left is tried again no sooner than this.
 */
export const NOT_DISPATCHED_RETRY_MS = 120_000;

/** basis: guessed — a flat proof older than 2.5 s is taken again before the refund is signed; verify: none needed
 * A flat proof older than this when the refund is signed is taken again.
 */
export const REPROVE_AFTER_MS = 2_500;

/** basis: guessed — a copy account still not flat 30 min into its abort is the owner's; verify: abort outcomes on Stage
 * The copy account proven not flat (a position, an order, margin:
 * setup_abort_proof_not_flat) waits; the same abort still not flat for more
 * than this is the owner's (setup_abort_not_flat_persistent, needs_owner).
 * Since when is kept on the row's backoff (notFlatSince); a flat proof
 * resets it.
 */
export const SETUP_ABORT_NOT_FLAT_ESCALATE_MS = 30 * MINUTE_MS;

/** basis: guessed — a blocked abort is looked at every 5 min, not every pass; verify: none needed
 * A blocked abort (a permanent or the owner's issue) is looked at again
 * this often, not every 30 s: what it waits for is someone's action. The
 * same block again changes nothing (repository.defer: no revision, no
 * updatedAt); anything that moved transitions it as usual.
 */
export const SETUP_ABORT_BLOCKED_RECHECK_MS = 5 * MINUTE_MS;

/** basis: guessed — the shared all-venue source serves one read a second; verify: gate 9 absence-proof socket timing
 * The shared all-venue source serves one read at a time, at most one a second.
 */
export const SOURCE_SPACING_MS = 1_000;

/** basis: guessed — a flat close that had to wait observes the account again after 10 s; verify: none needed
 * How long a flat close whose carry reset had to wait (a leg of the coin in
 * flight, or the account's risk locks busy) waits before it observes the
 * account again: each observation is a provider read.
 */
export const FLAT_CARRY_RETRY_MS = 10_000;

/** basis: guessed — a pending admin revoke is bounded at 30 min by default (COPY_LIVE_REVOKE_DEADLINE_MINUTES); verify: none needed
 * Default bound on a pending admin revoke (COPY_LIVE_REVOKE_DEADLINE_MINUTES).
 */
export const REVOKE_DEADLINE_MS = 30 * MINUTE_MS;

/** basis: guessed — a feed trade REST hasn't returned a minute later no longer holds coverage back; verify: fast-source audit misses on Stage
 * A trade the feed reported that REST still hasn't returned this long
 * after it happened no longer holds coverage back (the after-sweep audit
 * reports a fill the stream then missed).
 */
export const WITNESS_EXPIRY_MS = 60_000;

/** basis: guessed — follow-up reads of one leader start a second apart; verify: fast-source follow-up histogram
 * Follow-up reads of one leader start at least this far apart, doubling
 * (up to 8 s) while a witnessed trade stays missing.
 */
export const FOLLOW_UP_MIN_MS = 1000;

/** basis: guessed — … doubling to 8 s; verify: fast-source follow-up histogram
 */
export const FOLLOW_UP_MAX_MS = 8000;

/** basis: measured — evidence reads take ~4 s; a merged order is planned within 15 s of its legs
 * A merged order is planned within this long after its legs are merged
 * (evidence reads ~4 s): no leg merged older than the signal age less this.
 */
export const PLANNING_MARGIN_MS = 15_000;

/** basis: guessed — a below-minimum open keeps waiting only with 30 s of signal left; verify: gate 9 held opens
 * A merged open the planner finds below the minimum goes back to waiting
 * only while its lead's signal has at least this long left (else refused).
 */
export const HOLD_MARGIN_MS = 30_000;

/** basis: derived — inside the 5 s evidence clock, with a second for the close's own checks
 */
export const SNAPSHOT_MAX_AGE_MS = LIVE_EVIDENCE_MAX_AGE_MS - 1_000;

/** basis: guessed — an up-front weight reservation takes at most 10 s when the budget sets no bound; verify: none needed
 * Longest an up-front weight reservation (before any evidence clock) may
 * take when the budget itself sets no bound.
 */
export const RESERVE_BOUND_MS = 10_000;

/** basis: copied — the 5 s evidence clock, as how long an order approval is reused within one execution
 * Private to one execution. SQL grant reads and actual-POST freshness checks
 * still run every time; reuse never changes the exchange observation clock.
 */
export const APPROVAL_REUSE_MS = LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: guessed — an answered lock check answers the next assertHeld for 50 ms; verify: none needed
 * How recently an answered lock check, with no statement on the session
 * since, still answers the next assertHeld (`lockCheck`).
 */
export const LOCK_CHECK_REUSE_MS = 50;

/** basis: guessed — a `submitting` order older than 30 s is resumed after a restart; verify: none needed
 * A `submitting` order older than this is resumed (crash or restart).
 */
export const SUBMITTING_RECOVERY_MS = 30_000;

/** basis: guessed — a close-all the api didn't finish is resumed by the worker after a minute; verify: none needed
 * A close-all the api did not finish (it crashed after the control commit)
 * is resumed by the worker once it is this old.
 */
export const CLOSE_ALL_RESUME_AFTER_MS = 60_000;

/** basis: derived — a minute of the nonce's five-minute window left to sign and send
 * A setup's nonce keeps this much of its five-minute window to sign and send.
 */
export const SETUP_NONCE_MIN_REMAINING_MS = 60_000;

/** basis: measured — Hyperliquid's signed-action window is five minutes
 * The owner's consent to a return is valid this long after it is prepared.
 */
export const RETURN_CONSENT_WINDOW_MS = 5 * MINUTE_MS;

/** basis: measured — Hyperliquid docs: a nonce may be up to one day ahead of block time
 * Hyperliquid permits a nonce up to one day ahead of block time.
 */
export const FUNDING_NONCE_SKEW_MS = DAY_MS;

/** basis: measured — Hyperliquid docs: nonces must be within (T − 2 days, T + 1 day); an hour of margin
 * …and down to two days behind it (docs: "Nonces must be within (T - 2 days,
 * T + 1 day)"): a transfer signed with an older nonce can no longer execute.
 * An hour of margin on top.
 */
export const FUNDING_NONCE_EXPIRY_MS = 2 * DAY_MS + HOUR_MS;

/** basis: guessed — an order request may be on its way for 20 s (the transport's HTTP timeout); gate 9 records p50/p99
 * How long an order request may still be on its way (the transport's HTTP
 * timeout) …
 */
export const LIVE_HTTP_TIMEOUT_MS = 20_000;

/** basis: guessed — this machine's clock may run a minute ahead of the exchange's; gate 9 records the skew monitor
 * … and how far this machine's clock may run ahead of the exchange's.
 */
export const LIVE_CLOCK_SKEW_ALLOWANCE_MS = 60_000;

/** basis: derived — LIVE_HTTP_TIMEOUT_MS + LIVE_CLOCK_SKEW_ALLOWANCE_MS (was 30 s: less than both)
 * Past expiresAfter by more than both together, an order unknown by cloid
 * can no longer be in flight or accepted late (was 30 s: less than the
 * timeout plus any skew).
 */
export const NEVER_PLACED_GRACE_MS = LIVE_HTTP_TIMEOUT_MS + LIVE_CLOCK_SKEW_ALLOWANCE_MS;

/** basis: derived — INDEX_LAG_MS (fill index lag, measured p90 1.5 s, a minute of margin) + LIVE_EVIDENCE_MAX_AGE_MS (our clock ahead of the exchange's, as far as the certificate's own account snapshot allows): 65 s (was 80 s)
 * How far past a cancel the account's fill scan must reach before its
 * booked fills stand for an unacknowledged IOC's filled quantity. Every fill
 * of the order is stamped (exchange clock) at or before its cancel; the
 * scan's horizon is this machine's clock when it asked (`to = now`). Two
 * things can hide a fill from a scan that reached it:
 * - the fill index trails the exchange (a fill stamped earlier is published
 *   later): INDEX_LAG_MS, the same horizon fill-sync certifies reads to;
 * - this machine's clock running ahead of the exchange's, so `to` names an
 *   exchange instant that had not happened yet. The same certificate needs
 *   an account snapshot whose provider times are at most
 *   LIVE_EVIDENCE_MAX_AGE_MS behind our clock (freshProvider), so a release
 *   is only certified while our clock runs at most that far ahead
 *   (PROVIDER_CLOCK_SKEW_MS bounds only the other direction).
 * A request in flight is not a term: the provider reads its index when the
 * request arrives, after `to` (LIVE_HTTP_TIMEOUT_MS is NEVER_PLACED_GRACE_MS's
 * term, an order that may still land). A fill booked to the order after its
 * release still quarantines the account (copy-follower-ledger.ts).
 */
export const LIVE_FILL_SCAN_MARGIN_MS = INDEX_LAG_MS + LIVE_EVIDENCE_MAX_AGE_MS;

/** basis: derived — the shared mainnet mids read is cached 3 s; 10 s bounds a reference older than the 5 s frames
 * Source-network references may be older than the 5 s provider frames: a mid is the
 * shared mainnet mids read (3 s cache), leader capital the paper sizing's
 * 60 s cache. Both stay bounded and are never used past these ages.
 */
export const SOURCE_MID_MAX_AGE_MS = 10_000;

/** basis: derived — leader capital is the paper sizing's 60 s cache; 120 s bounds it
 */
export const SOURCE_EQUITY_MAX_AGE_MS = 120_000;

/** basis: guessed — one rejected 60 s testnet source read cost gate run 9 a trade (2026-10-14); verify: gate 10 records source retry delays
 * After a failed or incomplete testnet-leader source read, the next read
 * comes this long later, doubling per consecutive failure, never later than
 * the poll interval (COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS). A budget wait's
 * own later deadline still wins.
 */
export const TESTNET_SOURCE_RETRY_MS = 5_000;
