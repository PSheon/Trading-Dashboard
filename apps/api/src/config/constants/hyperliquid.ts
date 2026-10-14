/**
 * Hyperliquid's per-IP limits and how the shared meter and the local buckets divide them: caps, reserves, holds and waits.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { MINUTE_MS } from './time.js';

/** basis: measured — Hyperliquid docs: 1,200 REST weight per IP per minute
 */
export const HYPERLIQUID_REST_CAP = 1200;

/** basis: derived — api 480 + worker 360 of the 1,200 (MAINNET_WORKER_WEIGHT); the rest is the live reserve
 * What background work may hold of it; without it, background loops kept the
 * window full and cold trader pages answered 503.
 */
export const HYPERLIQUID_BACKGROUND_REST_CAP = 840;

/** basis: guessed — 20 % of the window kept for live orders (2026-10-11); verify: gate 9 live wait p99 with the reserve at 240
 * Neither setups nor background ever take it: live orders, pages and
 * exchange actions (unlabelled) always find at least this.
 */
export const HYPERLIQUID_LIVE_REST_RESERVE = 240;

/** basis: derived — 1,200 − the live reserve − the page floor
 * What copy setups' charges may hold of the window together (one setup's
 * account-mode attempt and its reconcile), so a burst of setups queues
 * instead of taking live room. While a setup waits, background is refused
 * first: without that, a mode step waited 10 minutes beside Stage-like
 * background load (2026-10-13).
 */
export const HYPERLIQUID_SETUP_REST_CAP = 720;

/** basis: copied — the live reserve's 240, as what pages always get after a hold; verify: page 503 rate on Stage
 * What page reads held back longer than HYPERLIQUID_PAGE_HOLD_MS may hold
 * of the window beside a waiting setup: pages never go dead, and a burst of
 * them delays the setup by at most this much (one cold trader page's reads).
 */
export const HYPERLIQUID_PAGE_FLOOR = 240;

/** basis: measured — gate 5 (2026-10-13): an account-mode step took up to ~40 s from grant to its last charge
 * How long a granted setup claim holds its step's weight: the weight is an
 * event of the window (SETUP_HOLD_ID_PREFIX) that ends then, unless the step
 * gives it back first (`setup_release`) or its own charges draw it all. The
 * step's charges up to it are admitted without any other check: they replace
 * held weight one for one (the window's total does not move), so no charge of
 * another lane that came between the claim and the reads can refuse them
 * partway (gate 2026-10-13 09:49: a granted attempt charged 410 and failed,
 * and its retry waited ~45 s for those 410 to expire). Long enough for the
 * attempt's two preflights, its signature and its POST.
 */
export const HYPERLIQUID_SETUP_GRANT_HOLD_MS = 45_000;

/** basis: derived — a waiting setup claims again every SETUP_CLAIM_RENEW_MS (20 s); 30 s keeps its place across one missed renewal
 * How long a setup's claim that does not fit yet keeps its place in the
 * queue after it was last recorded: the setup claims again at least every
 * 20 s (copy-live-setup SETUP_CLAIM_RENEW_MS), so a setup still waiting never
 * loses it, and one that gave up frees the room within this.
 */
export const HYPERLIQUID_SETUP_PENDING_HOLD_MS = 30_000;

/** basis: guessed — 20 claimants at once on a full window (gate 10 had one settlement, one order and up to two setup steps claiming); verify: the meter heartbeat's live and setup marker counts p99 at the next gate
 * Demand markers (1 unit each, never sent) the shared meter records over
 * HYPERLIQUID_REST_CAP on a full window: at most this many units. A live
 * claimant keeps one marker and a setup at most three (its first, for its
 * place in the queue, its latest grant and its latest), so a renewal reuses
 * its own room; a new claimant
 * past this is refused with a wait, as before 2026-10-15. Markers count as
 * taken room in every lane, so this is also the most they hold over the window.
 */
export const HYPERLIQUID_DEMAND_MARKER_CAP = 20;

/** basis: guessed — an order's SQL wait, 5 s evidence and POST fit in 15 s (2026-10-13); verify: gate 9 order duration p99
 * How long a live order's demand comes first after it is recorded: its
 * wait for its SQL locks, its 5 s evidence window and its exchange POST. An
 * order still waiting for room records it again (the same token); once no
 * order's demand is alive or outstanding, setups and background are as
 * before. A cold order's evidence (589, or 772 with two accounts) is more
 * than the 240 live reserve: beside a setup's share and background's cap it
 * was refused, and then waited out a 65 s window.
 */
export const HYPERLIQUID_LIVE_DEMAND_HOLD_MS = 15_000;

/** basis: derived — a third of HYPERLIQUID_LIVE_STANDBY_HOLD_MS
 * While live copies run, the shared meter's standby (one order's need kept
 * free) is renewed this often, well inside HYPERLIQUID_LIVE_STANDBY_HOLD_MS.
 */
export const LIVE_STANDBY_RENEW_MS = 10_000;

/** basis: derived — three renewals of LIVE_STANDBY_RENEW_MS (10 s)
 * How long a standby keeps its need free after it is recorded (the worker renews it every LIVE_STANDBY_RENEW_MS).
 */
export const HYPERLIQUID_LIVE_STANDBY_HOLD_MS = 3 * LIVE_STANDBY_RENEW_MS;

/** basis: derived — a page gives up after PAGE_CAPACITY_WAIT_MS (6 s) inside its 12 s deadline; 4 s leaves it its retry
 * Longest a page read is held back for a waiting setup: then it is admitted
 * within HYPERLIQUID_PAGE_FLOOR. A page waits for room at most 6 s in all
 * (PAGE_CAPACITY_WAIT_MS, inside its 12 s deadline), so the hold ends with
 * time left for its retry and the call; at 10 s every held page would have
 * answered 503 first.
 */
export const HYPERLIQUID_PAGE_HOLD_MS = 4_000;

/** basis: guessed — a third of the 30 connects a minute kept for live sockets (gate 7, 2026-10-13); verify: gate 9 ws_connect refusals by lane
 * Of the 30 socket connects a minute, what only live sockets (an original
 * live-risk session's, a live order's: its follower and leader account
 * observations, a stop's or a close's) may take: every other socket, and a
 * setup's claim for its step's connects, leaves it free. One order's
 * observations open about six (three per account and the leader's), and a
 * stop or close beside it a few more. Gate 2026-10-13 11:15 (7th run): the
 * harness's two socket loops (one connect every 2 s, as many as the window
 * holds) kept it full, and the order's follower observation was refused its
 * connect, twice (`live_account_observation_unavailable`, cause
 * `hyperliquid_quota_exhausted`), and so was the stop after it, many times
 * a second.
 */
export const HYPERLIQUID_LIVE_WS_CONNECT_RESERVE = 10;

/** basis: derived — the demand ticket's `:cN` field holds one digit
 * Socket connects one claim may ask to hold (an account-mode attempt opens two).
 */
export const HYPERLIQUID_MAX_SETUP_CONNECTS = 9;

/** basis: derived — past the 5 s send bound and Hyperliquid's 60 s idle close, with margin
 * How long after `leaseUntil` an unclosed lease still counts toward the
 * connection, subscription and user limits. Past it, a lease left by a killed
 * process can no longer hold a provider connection. The row stays
 * `uncertain` (never forged to `closed`) and no charged unit is refunded.
 */
export const HYPERLIQUID_STALE_LEASE_RECLAIM_MS = 5 * MINUTE_MS;

/** basis: derived — a worker's 840 burst holds one two-account-plus-leader order (772); 360/min keeps api 480 + worker 360 = the 840 background lane
 * Default (rate, burst); see `hyperliquid.budgetPerMin`.
 */
export const MAINNET_WORKER_WEIGHT = { perMin: 360, burst: 840 } as const;

/** basis: derived — the provider's 60 s window plus the 5 s send window of a charge
 * How long a REST charge holds the shared meter. Never applies to leases.
 */
export const REST_CHARGE_LIFETIME_MS = 65_000;

/** basis: derived — REST_CHARGE_LIFETIME_MS: a refusal that says no time is back once every charge ahead has expired
 * After the shared per-IP window refused a charge without saying when it
 * fits: no sooner than this (the provider's 60 s window plus the 5 s send
 * window of the charges in it). A refusal that says when
 * (HyperliquidRestCapacityError.retryAfterMs) is retried then.
 */
export const SHARED_CAPACITY_RETRY_MS = REST_CHARGE_LIFETIME_MS;

/** basis: guessed — a second between a shared-window refusal and its retry; verify: gate 9 claim-wait distribution
 * Earliest retry after a shared-window refusal, and what is added to the
 * meter's estimate (its clock and ours, the next charge's transaction).
 */
export const SHARED_CAPACITY_MIN_RETRY_MS = 1_000;

/** basis: guessed — the meter's clock and ours, plus the next charge's transaction; verify: gate 9 claim log waitMs vs actual
 */
export const SHARED_CAPACITY_SLACK_MS = 250;

/** basis: guessed — longer than a 5 s evidence clock, shorter than a setup step's budget (2026-10-12); verify: gate 9 local_budget waits by weight
 * Longest a setup step's read waits for its weight before its evidence clock
 * starts (a queued reservation waits up to stepBudgetMs.reserveWaitMs).
 */
export const LIVE_RESERVE_WAIT_MS = 8_000;

/** basis: guessed — a background turn or a 429 back-off can make a local estimate a second longer; verify: gate 9 local wait estimate vs actual
 * What `reserveLive` adds to a wait it allows.
 */
export const WAIT_SLACK_MS = 1_000;

/** basis: measured — 2026-10-13: a setup that came back after 65 s found its marker expired; 20 s stays well inside it
 * Longest a setup waits on the shared meter before it claims again: its
 * demand (the marker background yields to) is renewed well inside the
 * marker's 65 s, so background never gets the window back between two
 * claims. On 2026-10-13 a setup came back 65 s after its claim, its marker
 * had just expired, background had refilled the window, and the next claim
 * said ~63.5 s again: ten minutes at `funded`.
 */
export const SETUP_CLAIM_RENEW_MS = 20_000;

/** basis: derived — a keyed hold's caller comes back at least every SETUP_CLAIM_RENEW_MS (20 s); three misses abandon it
 * A keyed live reservation (`holdKey`) waiting with nobody asking for it is
 * abandoned after this (its caller comes back at least every 20 s).
 */
export const LOCAL_HOLD_IDLE_MS = 3 * SETUP_CLAIM_RENEW_MS;

/** basis: derived — half of LOCAL_HOLD_IDLE_MS: gathered weight nobody takes goes back within one claim cycle
 * A keyed reservation whose weight is gathered (or parked) but not taken is
 * refunded after this.
 */
export const LOCAL_HOLD_READY_MS = LOCAL_HOLD_IDLE_MS / 2;

/** basis: derived — inside LOCAL_HOLD_IDLE_MS, so a refused caller is back before its hold is dropped
 * Longest a keyed reservation's refusal asks its caller to stay away (well
 * inside LOCAL_HOLD_IDLE_MS).
 */
export const LOCAL_HOLD_RETRY_MS = 15_000;

/** basis: derived — HYPERLIQUID_LIVE_DEMAND_HOLD_MS less 5 s, so the demand is renewed before it lapses
 * A live order still waiting for room records its demand again this
 * often, well inside its HYPERLIQUID_LIVE_DEMAND_HOLD_MS.
 */
export const LIVE_DEMAND_RENEW_MS = HYPERLIQUID_LIVE_DEMAND_HOLD_MS-5_000;

/** basis: derived — half of a trader page's 12 s deadline, leaving room for the call
 * Longest an unlabelled request waits in all for shared REST capacity: within
 * a trader page's 12 s deadline, with room for the call itself.
 */
export const PAGE_CAPACITY_WAIT_MS = 6_000;

/** basis: guessed — inside the info client's 20 s request timeout (2026-10-07); verify: snapshot/sweep capacity-wait histogram on Stage
 * Longest a snapshot or sweep of watched leaders waits for background room.
 */
export const ESSENTIAL_CAPACITY_WAIT_MS = 15_000;

/** basis: derived — two REST_CHARGE_LIFETIME_MS: outlasts the page's own full list and one other background list (Stage 2026-10-07)
 * Longest a trade-analytics read (a background job a page started) waits for
 * background room. At 40 s a cold dense trader's second list could never wait
 * out the first one's 65 s and the page answered 503 on every retry (Stage
 * 2026-10-07). Analytics reads of one process go out one at a time.
 */
export const ANALYTICS_CAPACITY_WAIT_MS = 2*REST_CHARGE_LIFETIME_MS;

/** basis: guessed — a tenth of the main bucket only live may spend; verify: Stage order bucket reserve tokens over a week
 */
export const LIVE_RESERVE_SHARE = 0.1;

/** basis: measured — a cold trader page's first paint and chart ≈ 106–130 weight of a 200 burst
 * Share of the burst that is the page reserve.
 */
export const PAGE_RESERVE_CAPACITY_SHARE = 0.6;

/** basis: measured — a page list's real cost settles within a second of its worst-case surcharge
 * A page list's worst-case surcharge is forgiven in the next page list's
 * gate for this long, so a cold page's second list doesn't wait out the
 * first one's worst case (at most 100 weight beyond budget + burst).
 */
export const PAGE_LIST_GRACE_MS = 3_000;

/** basis: guessed — three quarters of the effective budget for the capped consumers together; verify: consumer caps vs refusals in the heartbeat
 */
export const CAPPED_SHARE = 0.75;

/** basis: guessed — half rate for the first window after a restart, since the previous process's sends still count; verify: 429s in the first minute after Stage deploys
 */
export const STARTUP_RATE_SHARE = 0.5;

/** basis: guessed — consumer caps re-read from settings every 30 s; verify: none needed (admin latency only)
 */
export const CAPS_TTL_MS = 30_000;

/** basis: guessed — half the budget for page work while background waits; verify: page vs background wait p99 on Stage
 * Measured over `PAGE_SHARE_WINDOW_MS`.
 */
export const PAGE_SHARE = 0.5;

/** basis: guessed — three minutes lets a few cold pages in a row go at once; verify: Stage page-wait histogram
 * Only a sustained flood is held to the share.
 */
export const PAGE_SHARE_WINDOW_MS = 3 * MINUTE_MS;

/** basis: guessed — one client may hold half the page queue; verify: page queue composition by client on Stage
 */
export const PAGE_CLIENT_SHARE = 0.5;

/** basis: derived — an order's evidence (589) and a setup's account mode (613) fit 80 % of an 800 or 900 burst
 * Share of a wallet-network bucket kept for real-money work (its reserve,
 * refilled first, never spent by background work): an order's evidence
 * (589) and a setup's account mode (613) fit 80 % of an 800 (testnet) or
 * 900 (mainnet live) burst whatever receipts and snapshots do.
 */
export const LIVE_HEADROOM_SHARE = 0.8;

/** basis: guessed — a 429 while our meter holds under 80 % of the window is someone else's use (design I-12); verify: observe week on Stage
 * `foreign_usage_suspected` (design §8 I-12, I-15): our meter counts all our
 * sends from that egress, so a rate-limit refusal below this share means
 * another tenant on Railway's shared egress. A non-zero count is the
 * evidence for moving a role to another region.
 */
export const FOREIGN_USAGE_SHARE = 0.8;

/** basis: guessed — a failed catalog read is retried after a minute while the last list answers; verify: none needed
 */
export const MARKET_CATALOG_RETRY_MS = 60_000;

/** basis: guessed — a caller waits 2 s for a new process's first catalog read; verify: cold-start page latency on Stage
 */
export const MARKET_CATALOG_WAIT_MS = 2_000;

/** basis: guessed — a dead info connection must not hold a caller (and its per-address chain) forever: 20 s; verify: none needed
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** basis: measured — Hyperliquid docs: 2,000 WebSocket messages per IP per minute
 */
export const HYPERLIQUID_WS_MESSAGE_CAP = 2000;

/** basis: measured — Hyperliquid caps a userFillsByTime-style list at 500 rows a page
 */
export const GENERAL_TIME_RANGE_CAP = 500;
