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
  order); positions match the leader's direction and end flat;
- `<scenario>_evidence_under_3500ms`: every order's evidence, read from the worker's
  `live_execution_timing` lines (`.claude/logs/worker-3010.log`, `--worker-log`), is under 3500 ms
  (`--evidence-max-ms`). Evidence is the runtime's `execute` mark to `runtime_hold` plus the executor's to
  `executor_submit_gate`: from the preparation's start to the last evidence check before the exchange, an
  upper bound of the age the 5 s window must hold. A gate scenario with no order fails;
- `<scenario>_no_evidence_failures`: no attempt failed `live_risk_stale`, a generation proof
  (`live_generation_unproven`, `live_risk_generation_unproven`, …) or another `EVIDENCE_FAILURES` code,
  even if a retry later settled;
- `contention_background_lane_full`: the background lane was full (refusals counted) while the scenarios ran;
- `no_stuck_rows` (after every run, dry runs too): no `copy_live_setups` row with an issue whose
  `next_attempt_at` is over 2 minutes past, and no `copy_live_stop_operations` / `copy_account_mode_operations`
  row with an issue in a non-final state, nor `copy_funding_operations` row (no issue column) in a non-final
  status, unchanged for over 2 minutes (those tables have no retry column, so `updated_at`). Whole local
  database; the failure lists table, id and issue;
- the 1 h follow: `follow_legs_settled`, `follow_no_unexpected_refusal`, `follow_zero_<code>` = 0 for
  `live_risk_stale`, `hyperliquid_busy`, `live_generation_unproven` and `live_risk_generation_unproven`
  (failed attempts and boundary failures in the worker log, and the dispatches' reasons: a retry that later
  settled still fails it), and its evidence check (a quiet trader with no order is a skip, not a pass:
  rerun with a busier one).

The summary (its path is the last line printed: `.claude/logs/copy-harness/<run>-summary.txt`) has every
check, then the gate table — per scenario the result and its orders' evidence p50 / p95 / max (ms) — then
each order's evidence spans summed per role (follower / leader / target / other_account / none) and each
span's p50 / p95 / max over the orders, so a regression shows which segment grew. Each scenario's orders,
spans and failed attempts are also in `.claude/logs/copy-harness/<run>-<scenario>-evidence.json`. The
evidence and failed-attempt checks run after every scenario on every profile.

The leader must be funded (`run.mjs` stops with exit 3 and says how much otherwise): at least 20 testnet
USDC in its perp account for its legs, plus the follower's top-up while the follower's main wallet holds
less than the 50 USDC budget.
