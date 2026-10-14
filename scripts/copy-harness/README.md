# Copy harness

The whole copy loop against the local stack (web 3000, api 3100, worker 3010) on Hyperliquid testnet: a
scripted leader (`leader.mjs`), the follower's one-click copy through the browser (`follower.mjs`), and a
reconciliation of every leg (`reconcile.mjs`, rules in `checks.mjs`). `run.mjs` runs it; its header lists
every scenario and flag. Testnet only: no real money.

## Pre-mainnet gate

Run before every real-money mainnet test. It exists because of two defects the local harness missed and a
mainnet test hit on 2026-10-12:

1. after the copy's first order, every open of a coin it had not traded yet was refused
   `live_generation_unproven` (fixed in 12ffefcb). The harness only ever traded one coin;
2. every order exceeded the 5 s evidence window (`live_risk_stale`) because its meter transactions
   cost ~2.3 s at Stage's ~8 ms database round trip (fixed in 8a964aee). Local Postgres answers in ~0 ms.

So the gate runs on the `stage-like` profile (`stage-like.env`: `ratio-floor.env` plus
`COPY_HARNESS_DB_RTT_MS=8`, every SQL statement of the api and the worker waits 8 ms first, `db-rtt.mjs`),
with Stage's background meter load (`--contention`, `contention.mjs`), and covers every leg type.

From the main checkout, one heavy step at a time:

```sh
# 0. the api built from the commit under test (when dev moved)
pnpm turbo run build --filter=@trading-dashboard/api --concurrency=1
# 1. the api and the worker on the stage-like profile (the worker's log then shows copy_harness_db_rtt 8)
node scripts/copy-harness/stack.mjs restart api --profile stage-like
node scripts/copy-harness/stack.mjs restart worker --profile stage-like
# 2. nothing signed or deposited: login, the setup up to its consent, every leg planned from live markets
node scripts/copy-harness/run.mjs --profile stage-like --scenarios gate --dry-run
# 3. the gate: new-coin, add-reduce, merged, flip, stop-open on one fresh copy (~25 min)
node scripts/copy-harness/run.mjs --profile stage-like --scenarios gate --contention
# 4. a real mainnet trader for an hour (a mainnet source on this testnet stack)
node scripts/copy-harness/run.mjs --profile stage-like --contention --leader <0x… mainnet trader> --scenarios follow --watch-min 60
# 5. back to the plain harness profile
node scripts/copy-harness/stack.mjs restart api && node scripts/copy-harness/stack.mjs restart worker
```

| scenario | legs |
| --- | --- |
| `new-coin` (21) | open BTC, wait for the follower's fill; a first open of ETH, then of SOL, each filled; close all three |
| `add-reduce` (22) | open ETH, a same-coin add, a partial reduce (half), a full close |
| `merged` (23) | three opens 3 s apart, then three reductions 3 s apart: legs merged into one order (ratio sizing); follower flat |
| `flip` (24) | open long, then long → short in one leader fill (a close and an open leg), then close |
| `stop-open` (4) | stop while a position is open: flat, the return credited, shown stopped |

Pass criteria (exit 0, `ALL GREEN`, and every row of the gate table `PASS`):

- `stack_worker_db_rtt`: the worker's latest start ran with the profile's round trip (8 ms);
- `<scenario>_reconcile`: every leader leg has a dispatch that settled with the follower's fill, or was
  refused for an allowed reason (`no_follower_position`, a HIP-3 market, or merged into another leg's
  order); positions match the leader's direction and end flat. **harness_timing** (counted and listed in
  the check's detail and in `<run>-<scenario>-reconcile.json` `harnessTiming`, never a failure): the
  scenario ended or aborted before the copy's source could have read a leader order
  (`criteria.mjs` harnessTimingCause, `checks.mjs`):
  - `leader_order_without_dispatch` whose order is later than `copy_live_source_streams.coverage_through`
    (what the stream's last completed read covered; read before the dispatches, so a read landing in
    between can only add dispatches). With no coverage row (no database, no stream), an order later than
    the reconcile's time minus one source poll interval (`--source-poll-ms`, the profile's
    `COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS`, 60 s). Coverage, when read, decides alone: **an order a
    completed read covered that has no dispatch remains a FAIL**;
  - `direction_mismatch` on a coin with such an order when the follower holds the leader's direction from
    just before the first of them (the first fill's `startPosition`): the follower is where the copy's
    last read left it. Any other mismatch FAILS, and so does `follower_not_flat`.

  `run.mjs` keeps retrying the reconcile (every 15 s, up to 4 min) while an order is unread, as it does
  for a failure, so harness_timing only stands when the deadline passes or a terminal failure
  (`signal_expired`, `refusal_not_allowed`) ends the scenario;
- `<scenario>_evidence_under_3500ms`: every order's **judged** evidence, read from the worker's
  `live_execution_timing` lines (`.claude/logs/worker-3010.log`, `--worker-log`), is under 3500 ms
  (`--evidence-max-ms`). Evidence is the runtime's `execute` mark to `runtime_hold` plus the executor's to
  `executor_submit_gate`: from the preparation's start to the last evidence check before the exchange, an
  upper bound of the age the 5 s window must hold. A gate scenario with no order fails. Judged
  (`criteria.mjs` dexFanout):
  - a **mainnet** order (its timings' `network`): the raw evidence, unchanged;
  - a **testnet** order: the raw evidence minus the testnet dex fan-out. Each observation subscribes
    `openOrders` once per perp venue (perpDexs: the main dex and every HIP-3 dex; testnet ~270, mainnet
    11) plus one `allDexsClearinghouseState`, for the follower and for the leader. The run reads the
    venue count once from the testnet info API (`perpDexs`); unreadable, the raw number is judged. Of S =
    venues + 1 subscriptions, all but the aggregate state and the main dex (2 fixed) are fan-out: share =
    (S − 2) / S. The spans give a critical-path attribution: per role, the subscribe path of one socket
    (`(ws_messages + quota_subscribe_queue + quota_subscribe_tx) / sockets`, sockets = `ws_messages`'
    count; the roles and their sockets run at the same time, so summed totals overlap) × share, at most
    that role's `observer_ws`; the fan-out is how much earlier the later role's `observer_ws` would end
    without it;
  - recorded beside it (never judged): the fan-out's unit cost, ms per dex on one socket of the critical
    role, and the projection to mainnet, judged evidence + unit × (`--mainnet-dexes` − 1) (11 by default:
    one socket carries them all). The raw number stays in the detail and in the gate table;
- `<scenario>_no_evidence_failures`: no attempt failed `live_risk_stale`, a generation proof
  (`live_generation_unproven`, `live_risk_generation_unproven`, …) or another `EVIDENCE_FAILURES` code,
  even if a retry later settled;
- `contention_background_lane_full`: the background lane was full (refusals counted) while the scenarios ran;
- `no_stuck_rows` (after every run, dry runs too): no `copy_live_setups` row with an issue whose
  `next_attempt_at` is over 2 minutes past, and no `copy_live_stop_operations` / `copy_account_mode_operations`
  row with an issue in a non-final state, nor `copy_funding_operations` row (no issue column) in a non-final
  status, unchanged for over 2 minutes (those tables have no retry column, so `updated_at`). Whole local
  database; the failure lists table, id and issue;
- signal latency (the summary's latency block, measured, not a check): `fill → dispatch created (source
  poll)` is the leader fill to `copy_live_dispatches.created_at`, the testnet source's REST poll interval
  (60 s): a harness fact, recorded only; `dispatch created → sent (ours)` is `created_at` to `sent_at`,
  the copy's own part and the one any latency judgement uses. Both are in the reconcile's
  `signalLatencySeconds`;
- the 1 h follow: `follow_legs_settled`, `follow_no_unexpected_refusal`, `follow_zero_<code>` = 0 for
  `live_risk_stale`, `hyperliquid_busy`, `live_generation_unproven` and `live_risk_generation_unproven`
  (failed attempts and boundary failures in the worker log, and the dispatches' reasons: a retry that later
  settled still fails it), and its evidence check (a quiet trader with no order is a skip, not a pass:
  rerun with a busier one).

Still to script, and to pass by hand until then (the order-path fixes O3, O4, O6 and O9 of 2026-10-12 are
covered by unit and database tests only):

- same-ms burst (O3): the leader sends one market order that sweeps 500+ resting makers, or 500+ fills
  land in one millisecond. Pass: the stream's `coverage_through` moves past that millisecond within one
  read (`copy_live_source_streams`), the burst's legs are enqueued, and no `source … in gap` line follows;
  a burst a single read cannot hold (2,000+ fills in one ms) shows `ALERT fast source` / `ALERT watched
  source` and the stream in `gap`, never a silent stall;
- quick re-open after flat (O4): with the follower left holding part of a coin after the leader closed it
  (an IOC close that filled partly), the leader opens that coin again before the reconcile close runs.
  Pass: the reconcile close ends `refused` `leader_reopened` without an order, the new open waits until
  then and settles, and the leader's next close of the coin is sent (not `position_closed_by_owner`);
- re-verify during a copy (O6): while a copy runs, the owner re-verifies the copy wallet once with the
  wallet provider failing (`provider_unavailable`), then again successfully. Pass: the account's
  `revision` is unchanged, the copy's next leader leg settles, and an order in flight during the failed
  check reconciles;
- clock skew (O9): the worker's clock set 1.5 s ahead of real time, then 1.5 s behind (one run each).
  Pass: no `live_risk_stale`, `live_account_evidence_expired`, `live_settlement_stale` or
  `follower_execution_identity_mismatch`; the worker logs `WARN clock skew` and its heartbeat shows
  `clockSkew.warning` true.

The summary (its path is the last line printed: `.claude/logs/copy-harness/<run>-summary.txt`) has every
check, then the gate table — per scenario the result, its orders' judged evidence p50 / p95 / max (ms), the
raw max and the mainnet projection's max — then
each order's evidence spans summed per role (follower / leader / target / other_account / none) and each
span's p50 / p95 / max over the orders, so a regression shows which segment grew. Each scenario's orders,
spans and failed attempts are also in `.claude/logs/copy-harness/<run>-<scenario>-evidence.json`, with the
venue count read and each order's `fanout` (per role, the critical role, fan-out, adjusted, ms/dex, projection). The
evidence and failed-attempt checks run after every scenario on every profile.

## Measurements (gate run 9)

After the gate table and the spans, the summary ends with a separated `MEASUREMENTS` block (`measure.mjs`,
unit-tested in `measure.test.mjs`). It records values, never pass/fail: they re-base the real-money path's
guessed constants (`docs/egress-subtraction-inventory-2026-10-15.md` §2.3 item 3) and keep the rate-limit
record of `docs/design-hl-egress-2026-10-13.md` §8 I-17. The window is the whole run; the inputs are also in
`.claude/logs/copy-harness/<run>-measurements.json`.

| | what | read from |
| --- | --- | --- |
| 1a | exchange POST round trip per order, n / p50 / p95 / p99 / max; POSTs with no answer recorded (`LIVE_HTTP_TIMEOUT_MS` 20 s) | `copy_live_dispatches.sent_at → acked_at` of the run's copies (the transport's request and response); beside it the `executor_submit` mark of each `live_execution_timing` line (the submit call: its pre-POST risk check plus the POST, an upper bound) |
| 1b | counted attempts of each settled close leg (`CLOSE_ATTEMPT_LIMIT` 30), and the close legs that did not settle | `copy_live_dispatches.attempts` (budget waits are not counted there) |
| 1c | per leg, the attempt suffixes its journals used, 1–3 (`MAX_LIVE_LEG_ATTEMPTS` 3), and its counted attempts | `copy_live_executions.cloid` matched against the leg's cloids 0..2 (`legAttemptCloid`, pinned to `copy-live-leg-attempt.ts`); `leg … released as never sent` lines |
| 1d | per failure code, failed attempt → the leg's next try (`LIVE_LEG_RETRY_POLICY` 3 s): the next failed attempt's start (its line's time minus its `elapsed`), or after the last failure the order's `sent_at` (an upper bound); `budget_wait` when the engine logged `budget unavailable` for it, with that wait's own retry | worker log `leg <id> attempt N failed: <code>; elapsed …` and `leg <id> budget unavailable: …, retry … ms`; `sent_at` |
| 1e | signer `walletCheckedAt` age at signing | not logged by the worker. Shown instead: `signer_wallet_identity → signer_approval` of the `sign` phase (a lower bound: the prefetch's read starts earlier) and `signer_rpc`. The real value needs an api change: log `now - walletCheckedAt` in `privy-order-signer.ts` assertRpcFresh (or as a sign-phase timing) |
| 2 | each worker's `foreignUsage {rateLimited, count}` and `egressIdentity.publicIps` at the start and the end, the deltas, IPs added or dropped and IPs two workers share (a counter that went down: the worker restarted); `foreign_usage_suspected`, `hl_ws_error_unmatched` (with its texts) and HTTP 429 lines (Hyperliquid's and others', by logger) in the window | `GET <worker>/health` (`--measure-workers url,url`, default `--worker`); worker log |
| 3 | setups' shared-meter claim waits: count, longest wait, per setup and step (`funded` → account mode, `mode_set` → agent, `agent_active` → builder fee: the setup's last stage the harness polled before the line) and the meter's composition at the longest wait | worker log `setup <id> claim waits {need, waitMs, meter}`; the harness's own setup polls |

Nothing in the block names the database URL or a key; psql's errors are reduced to their exit code.

The leader must be funded (`run.mjs` stops with exit 3 and says how much otherwise): at least 20 testnet
USDC in its perp account for its legs, plus the follower's top-up while the follower's main wallet holds
less than the 50 USDC budget.

## Mainnet evidence probe (read-only)

`mainnet-evidence-probe.mjs` runs `apps/api/test/manual-mainnet-evidence-probe.e2e-spec.ts` (e2e config and
`HL_MAINNET_PROBE=1`: never in CI) through the isolated api test runner. It runs the order path's real provider epoch
(`LiveProviderReadEpoch.collect` with the shared reads, the account observer and its WS account source, the market
resolver and the risk provider) on an original `PostgresLiveRiskScope` session, every read metered by
`PostgresHyperliquidQuota` on that session, every SQL statement 8 ms late (`db-rtt.mjs`), against Hyperliquid
**mainnet**; then the exchange boundary's provider reads (`extraAgents` twice, `maxBuilderFee`). Only the SQL
authority's content is a double. Its fetch and socket wrappers refuse anything but mainnet info POSTs and WS
subscribe / unsubscribe / ping: nothing is signed or sent to `/exchange`. It also measures the fill index lag
(`userFillsByTime` of a busy public address polled every 4 s; a current-status isotonic estimate and per-fill brackets).

```sh
node scripts/copy-harness/mainnet-evidence-probe.mjs run --runner <wrapper supplying TEST_DATABASE_ADMIN_URL> \
  --runs 20 --close-runs 6 --fill-lag-min 10        # ~40 min, under ~450 weight/min
node scripts/copy-harness/mainnet-evidence-probe.mjs report <json>
```

First run, 2026-10-14 (`docs/evidence/mainnet-evidence-probe-2026-10-14.txt`): follower-like `0x13d2…d43c` (role
user, abstraction disabled, one HYPE position), leader `0x2e30…4cb5`, coin ETH, 11 perp dexes. Ratio open (leader
included, leverage checked), 18/20 ok (2 × `live_account_observation_changed`): evidence age at collect's return
p50 / p95 / max 1441 / 1793 / 1793 ms, 1821 / 2515 / 2515 ms with the boundary reads; meter SQL inside the clock
11 requests, Σ tx 625 / 681 / 681 ms (wall 628 / 688 / 688); REST weight 168 warm, 388 cold; 2 sockets, 24
subscriptions, 48 messages. Close (no leader), 6/6: 1208 / 1455 / 1455 ms; meter 6 requests, 372 / 401 / 401 ms.
Fill index lag (819 fills): p50 37, p90 722, p99 3752 ms; the oldest fill a poll missed was 6.3 s old.

The probe also records the account observer's freshness checks (`fresh` / `freshProvider`, wrapped on its
prototype in the probe's process only): each call site by its source text and line, the account's role and its
age (now − at, ms), and on a refusal why (`ahead_of_clock` / `older_than_bound` / …); each all-venue snapshot's
provider `time` against our clock; the wall clock's drift against the monotonic one. The report lists the
refusals and, per check, each run's largest age. Run of 2026-10-14, 42 open epochs, 0 refusals
(`docs/evidence/mainnet-evidence-probe-freshness-2026-10-14.txt`).
