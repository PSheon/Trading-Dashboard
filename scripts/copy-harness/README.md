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

**Testnet evidence window 7000 approved by Paul 2026-10-16 (testnet 273 dexes; mainnet stays 5000).**
`stage-like.env` sets `COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS=7000`: testnet lists 273 perp dexes (mainnet 11), its
dex fan-out alone took 1.5–1.6 s and raw order evidence 4.7–5.1 s (gate 11), so every attempt was
`live_risk_stale` and the setup's account-mode evidence expired. The api and the worker refuse to start with it
on a mainnet `HYPERLIQUID_NETWORK`; the api image never carries `scripts/`. The gate's judged limit (< 3500 ms) is
unchanged, and the summary's gate title, its `window` column and every evidence check's detail name the window in
force (5000 or 7000): a 7000 run is never mainnet-equivalent.

From the main checkout, one heavy step at a time. The Stage-like way runs the worker split in two, as
Stage does (`--roles split`, below): the all-role worker's orders share the local bucket with the
TradeAnalytics / Cohort / Leaderboard reads (gate 13's 18 s prepay wait was partly that artefact).

```sh
# 0. the api built from the commit under test (when dev moved)
pnpm turbo run build --filter=@trading-dashboard/api --concurrency=1
# 1. the stage-like profile with the roles split: the copy worker first (an all-role worker holds the
#    read lease; stack.mjs refuses to start the read worker beside one), then the read worker (3011),
#    then the api (it gets WORKER_READ_URL and merges both heartbeats). The worker's log then shows
#    copy_harness_db_rtt 8, its heartbeat worker.role copy, the read worker's worker.role read.
node scripts/copy-harness/stack.mjs restart worker --profile stage-like --roles split
node scripts/copy-harness/stack.mjs restart worker-read --profile stage-like --roles split
node scripts/copy-harness/stack.mjs restart api --profile stage-like --roles split
node scripts/copy-harness/stack.mjs status --roles split
# 2. nothing signed or deposited: login, the setup up to its consent, every leg planned from live markets
node scripts/copy-harness/run.mjs --profile stage-like --roles split --scenarios gate --dry-run
# 3. the gate: new-coin, add-reduce, merged, flip, stop-open on one fresh copy (~25 min)
node scripts/copy-harness/run.mjs --profile stage-like --roles split --scenarios gate --contention
# 4. a real mainnet trader for an hour (a mainnet source on this testnet stack)
node scripts/copy-harness/run.mjs --profile stage-like --roles split --contention --leader <0x… mainnet trader> --scenarios follow --watch-min 60
# 5. back to the plain harness profile and the one all-role worker (the read worker is stopped by PID)
node scripts/copy-harness/stack.mjs restart api && node scripts/copy-harness/stack.mjs restart worker
kill "$(lsof -tnP -iTCP:3011 -sTCP:LISTEN)"
```

**Worker roles (`stack.mjs --roles split`, `run.mjs --roles split`; `stack-plan.mjs`, tested in `stack.test.mjs`).**
`WORKER_ROLE` (`apps/api/src/runtime/worker-role.ts`, `docs/worker-deployment.md` 角色拆分) splits the worker
into a `copy` worker, lease (73106,1) — the live engine, stops, closes, settlement, the setup driver, the
trade feed and the fast source — and a `read` worker, lease (73106,2) — scheduler crons, traders, discovery,
cohorts, leaderboard, follower snapshots, outbox, Telegram. `stack.mjs restart worker --roles split` starts the
3010 worker as `WORKER_ROLE=copy`, `restart worker-read --roles split` the read worker on 3011
(`.claude/logs/worker-read-3011.log`, `/health` on its port), and `restart api --roles split` gives the api
`WORKER_READ_URL=http://localhost:3011`. Without `--roles` (all) the worker runs every role as before and gets no
`WORKER_ROLE` (one left in the shell is dropped: the api refuses it, and it would silently make the worker a
copy one). `run.mjs --roles split` adds `stack_worker_roles` (both heartbeats' roles; without the flag the check
is a SKIP naming the all-role worker), restarts the worker as `copy` in the worker-restart scenario, measures
the read worker's heartbeat (I-17) and names the roles in the MEASUREMENTS block beside the local-bucket waits
(1d: `local-bucket waits measured on: all-role worker …` or `roles split: …`). No api change was needed: the
worker reads `WORKER_ROLE` / `WORKER_PORT`, the api `WORKER_READ_URL`, all already there.

**Legs in flight are waited for (gate 13).** The flip's reconcile window closed 36 s after the leader's last
order while a legitimate follower attempt was running (dispatch `pending`, `first_attempt_at` set); the scenario
was judged FAIL and the final stop then cut that attempt with a misleading `live_risk_mandate_changed`. Before a
scenario's reconcile and before the final stop, `run.mjs` now waits (`lib.mjs` `waitForInFlight`, polled every
3 s from `copy_live_dispatches`) while any leg of the run's copies is in flight — `submitted`, or `pending` with
a running attempt (`first_attempt_at`) or a retry due (a counted attempt or a reason, the engine's retry marker;
the table has no next-attempt column) — for at most the risk policy's signal-age limit plus 30 s, 150 s in all
(`maxSignalAgeSeconds` from `GET /admin/copy/risk` with the admin token, else the policy's default 120 s).
Nothing in flight: no wait. Logged as `scenario_wait_in_flight {scenario, dispatches, waitedMs, polls, left,
waitMs, signalAgeLimitMs}`; a wait that gave up fails `<scenario>_in_flight_settled` (a leg still pending past
the limit is the engine's defect). A fresh pending leg nobody attempted yet (merging, or the next engine pass) is
not in flight.

| scenario | legs |
| --- | --- |
| `new-coin` (21) | open BTC, wait for the follower's fill; a first open of ETH, then of SOL, each filled; close all three |
| `add-reduce` (22) | open ETH, a same-coin add, a partial reduce (half), a full close |
| `merged` (23) | three opens 3 s apart, then three reductions 3 s apart: legs merged into one order (ratio sizing); follower flat |
| `flip` (24) | open long, then long → short in one leader fill (a close and an open leg), then close |
| `stop-open` (4) | stop while a position is open: flat, the return credited, shown stopped |

**Per-scenario criteria; the gate keeps running (the reviewer's ruling, 2026-10-17).** Gate 12 stopped after one
merged order's judged evidence of 3591 ms (criterion < 3500, unchanged), so flip and stop-open never ran. Now each
scenario is judged on its own checks (`criteria.mjs` `classifyScenario`), and the summary's verdict block sorts a
failure into two classes:

- **criterion miss**: an order's judged evidence at or over 3500 ms with no money effect — every leg still settled
  or was refused for an expected reason (the scenario's reconcile, mirrors and stops passed). Recorded as `FAIL`
  (`<scenario>_evidence_under_3500ms`, the row, the exit code); the copy goes on to the next scenario and to the final
  stop. A `<scenario>_no_evidence_failures` failure whose retry settled continues the same way;
- **trip-wire hit**: a leg that lost all its attempts to evidence age — the engine's `leg … refused:` line names
  `live_risk_stale` / `live_account_evidence_expired`, or `signal_expired` after attempts that failed for them
  (`last …`, or the leg's failed attempts) — or evidence-age failed attempts over 5 % of the run's attempts (failed
  attempts without budget waits, plus the orders that reached the executor). A lost open also fails the reconcile
  (`signal_expired`), so it aborts; a hit whose leg settled later is recorded and the gate continues;
- **abort** (the later scenarios `SKIP`, the copy still stopped at the end): only a failure that makes continuing
  unsafe or meaningless — a leader leg, a mirror, the reconcile (positions that do not match, a leg lost), the
  follower not flat, a stop (never blocked, flat, return credited, shown stopped). The summary says
  `aborted after <scenario>: <checks>`.

The gate table's `miss` and `trip` columns carry each scenario's counts (the `all` row: scenarios with a miss, hits
summed) beside `sent`, the copy's own signal latency dispatch created → order sent (s, p50; `all`: the largest max);
the verdict block then repeats each class with its definition and the legs lost, and ends with the verdict line —
`gate: PASS` only when every scenario passed every criterion, else
`gate: FAIL (criterion miss: n scenarios; trip-wire hits: m)` (`; other: k check(s)` for a failure of neither class;
`; aborted after <scenario>` when the gate stopped) — repeated as the summary's last line. When the window in force is
not 5000 the block adds a **note** (never a criterion): two-coin mirroring under saturated contention is not provable
on testnet (273 dexes: two observations need ~1750 units per 120 s against the 1200/min window); the mainnet
requirement is ~575 free units/min.

Pass criteria (exit 0, `ALL GREEN`, `gate: PASS`, and every row of the gate table `PASS`):

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
raw max, the mainnet projection's max, the evidence window in force, its criterion misses and trip-wire hits and
its dispatch created → sent latency — then the verdict block (above), then
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
