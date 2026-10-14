# HL egress capacity: design (2026-10-13)

> Status: a design draft. No code was changed. Line numbers refer to `HEAD` = `195c82ce`.
> Save as `docs/design-hl-egress-2026-10-13.md`.
> Tags: **[code]** read from the code. **[SDK]** from the installed `@nktkas/hyperliquid@0.33.3` type definitions, which are not an HL contract. **[verify]** must be proven on testnet or by HL before anything relies on it. **[est]** is my own arithmetic.

---

## 0. Summary

1. **The premise needs one correction.** The dex fan-out does not drive the REST weight. The 568 / 772 REST weight per order comes from the *per-account mode reads*: `userRole` 60 + `userAbstraction` 20 + `userDexAbstraction` 20 + `spotClearinghouseState` 2, read twice for each account (`live-shared-reads.ts:34-35,52-67`). The 635 for the account-mode step is also all REST (`copy-account-mode.service.ts:87-122`). The dex fan-out costs **WebSocket** capacity instead: one `openOrders` subscription for each of the ~268 testnet venues on every account read (`live-account-ws-source.ts:300,319-320`). It is the WS limits, not REST, that make orders, setups and snapshots starve each other on testnet:
   - 2000 messages/min,
   - 30 connects/min,
   - 10 connections,
   - **1000 concurrent subscriptions**,
   - **10 unique users** (`hyperliquid-global-quota.ts:386,526-527`).
2. **Dex scoping is feasible without weakening the proof, but it rests on new HL facts that must be verified.**
   - Positions and margin on *every* dex already come from one subscription, `allDexsClearinghouseState`. The fan-out exists only for **open orders**.
   - No REST or WS endpoint returns open orders across all dexes in one call. `openOrders` and `frontendOpenOrders` take one `dex` each [SDK].
   - The candidate cheap aggregate is the user's **order history**: REST `historicalOrders` or WS `userHistoricalOrders`. Neither takes a dex parameter [SDK].
   - If the history covers HIP-3 dexes and is complete (V1–V4 in §1.3), then any dex absent from the history and empty in `allDexsClearinghouseState` provably has no resting order.
   - Until V1–V4 are proven, the full scan stays the default.
3. **Most of the REST saving comes from where the code runs, not from scoping.**
   - A setup run in the api process warms the *api's* read cache (`copy-account-mode.service.ts:237-242`). The worker's first order then pays cold: 589 instead of 69.
   - With one copy process, the setup and the first order share one cache.
4. **Topology:** web, api, **worker-copy** (singleton, IP A), **worker-read** (singleton, IP B), Postgres.
   - worker-copy is the only process on IP A, so its limiter can be an in-memory priority scheduler (Phase 2). The lanes, claims and holds can then be retired.
   - Pages go on IP B, shared with worker-read, or on the api's own IP C.
   - B keeps a simplified Postgres meter only if two processes share it.
5. **Phases:**
   - **Phase 1a** (code, behind flags): dex scoping (shadow first) and role split.
   - **Phase 1b** (infra): distinct static egress and distinct egress keys.
   - **Phase 2**: in-memory scheduler on A, api exchange POSTs delegated to A, lanes retired.
   - **Phase 3**: self-hosted node. It makes the full scan cheap again without the history assumption.

---

## 1. Cut demand

### 1.1 Where the cost really is (today, testnet, D ≈ 268 venues including `''`)

| Operation | REST (meter units) | WS messages | WS connects | Concurrent subs | Source |
|---|---|---|---|---|---|
| Order evidence, 1 account, cold | 364 + 21 boundary = 385 | ~272 (1 + 268 subs, 3 closes) | 3 | 269 | `live-shared-reads.ts:64-67,95`; `live-execution-runtime.ts:214,303` |
| Order evidence, 2 accounts, cold | 568 + 21 = 589 | ~542 | 4 | 538 | same |
| 2 accounts + ratio leader, cold | 772 + 21 = 793 (startup bound) | ~542 | 4 | 538 | `live-shared-reads.ts:112-119` |
| Order evidence, 2 accounts, **warm cache** | 48 + 21 = 69 | ~542 | 4 | 538 | `live-shared-reads.ts:78-86`; `live-read-cache.ts:24-27` |
| Settlement observation (settler) | 284 cold / 4 warm (+ receipts ~45, market and status 22) | ~540 (reusable sockets unsubscribe) | 2 | 538 | `copy-live-settler.ts:132-144`; `live-account-observer.ts:73-74` |
| Account-mode step (attempt + reconcile) | **635** | 2 × 270 = 540 | 2 | 269 each | `copy-account-mode.service.ts:87-125`; `copy-account-mode-evidence.ts:45-52,152-155` |
| Follower snapshot (worker, once/min) | 284 / 4 | **538** (batches of 90, subscribe and unsubscribe) | 1 | ≤ 269 | `copy-worker.module.ts:22-27`; `live-account-ws-source.ts:319,352` |
| Setup-abort flat proof | 284 cold | ~271 | 2–3 | 269 | `copy.module.ts:146-150` |

**What follows on testnet [est]:**
- One copied open with two accounts and its settlement costs about 1,080 WS messages and 6 connects. That is more than half of the IP's per-minute message limit and a fifth of its connects.
- The 1000-subscription cap admits about **three all-venue reads at once**. Example: an order (538) + a snapshot (269) + a setup's absence proof (269) = 1076, and the meter refuses it (`hyperliquid_quota_subscriptions`). This matches the gate failures logged in `eeafb6e5` and `2eb3a32b`.

The REST side of the order path is already small when the cache is warm (69). It is large only when the cache is cold. The cache is cold mainly because setups run in a different process (the api) from orders (the worker).

### 1.2 What the code relies on for safety (must not weaken)

- **Every dex's state is read.** The observer requires one `allDexsClearinghouseState` row per venue in `perpDexs` (`live-account-observer.ts:306-311`).
- **Activity on an unsupported dex is refused.** Any non-zero state *or resting order* on a dex that is not counted fails with `live_account_unsupported_dex_exposure` (`:404-409`).
- **Orders are required for every venue**, either from the WS proof (`:314-338`) or, on the legacy path, by marking the coverage incomplete (`:429-439`).
- **Downstream checks require full order coverage.** They demand `observedOrderDexes == listedDexes` and `unobservedOrderDexes = []`:
  - `live-account-risk.ts:136-141`
  - `live-reservation-settlement.ts:146-151`
  - `copy-live-setup-abort-return.repository.ts:123-126`
  - `live-account-view.ts:34`
- **The absence proof (setup)** requires zero state on every venue and zero orders on every venue (`copy-account-mode-evidence.ts:160-176`). It also re-reads `perpDexs` at the end (`:178-182`).
- **The copy engine never trades HIP-3.** HIP-3 orders are refused (`copy-live-engine.ts:90-91`). A dedicated copy account's legitimate order footprint is therefore `{''}`.

So the guarantee is: **at the evidence time, the full set of resting orders across all dexes is known**. Positions and margin across all dexes are already proven by one subscription. Only the order set needs a cheaper proof.

### 1.3 Endpoints considered

| Candidate | Proves "no order on dex X"? | Verdict |
|---|---|---|
| `allDexsClearinghouseState` (WS, 1 sub) | Positions and margin on all dexes. **Not orders.** | Keep (already used) |
| `clearinghouseState` without `dex` | Default dex only | No |
| `spotClearinghouseState` | Spot only | No |
| `perpDexs` | The list of venues, nothing about the user | Used for coverage only |
| `openOrders` / `frontendOpenOrders` (REST or WS) | One dex per call (`dex` parameter) [SDK] | That is the fan-out. REST would be 20 × 268 weight. |
| `webData2` (REST/WS) | Default dex `clearinghouseState` and `openOrders` [SDK] | No |
| `webData3` (WS) | `userState.abstraction`, `dexAbstractionEnabled`, `agentAddress`. `perpDexStates` carries **no user orders** [SDK] | No for orders. Could replace two mode reads, but `userDexAbstraction`'s `null` vs `false` matters (`live-account-observer.ts:140,153`) and webData3 has an optional boolean. Not equivalent; skip. |
| `orderUpdates` (WS, user, no dex parameter) | A stream with no snapshot | Only useful from a known-empty start held continuously. The **10-users-per-IP** cap forbids a persistent subscription per account. Detector only. |
| **`historicalOrders` (REST, 20 + 1 per 20 items, ≤ 120)** / **`userHistoricalOrders` (WS, 1 sub)** | Every order the user placed, with status, no dex parameter [SDK] | **The candidate**, if V1–V4 hold |

**What must be verified on testnet before scoping can go live:**
- **V1.** History includes HIP-3 dex orders (coin `dex:COIN`), placed by any signer: master, any agent, or the UI.
- **V2.** A resting order appears in history from placement (status `open`). This includes trigger and TP/SL orders and partially filled orders.
- **V3.** The size cap of the history list (2,000?) and its sort key (placement time or oid, versus status time).
- **V4.** The WS `userHistoricalOrders` initial snapshot equals the REST answer, and later frames push new orders.
- **V5** (supporting only). Whether a resting non-reduce-only order can survive after its dex's collateral is moved out. This is not used for safety; it only explains anomalies.

### 1.4 Dex-scoped observation (the design)

For account `U`, inside the existing 5 s evidence clock:

1. Subscribe on one socket to `allDexsClearinghouseState{U}` and `userHistoricalOrders{U}`. Fallback: REST `historicalOrders`, paid before the clock.
2. **Scope** `T = {''} ∪ {dexes with any non-zero state in allDexs} ∪ {dexes of any order in history} ∪ T_db(U)`.
   - `T_db(U)` is the account's persisted touched set. Add it as a new column on `copy_execution_accounts`, or as a side table.
3. **Completeness of history:**
   - **(a)** The history list is not saturated (fewer entries than the cap). Then it is the full order history, so `T` is complete.
   - **(b)** The list is saturated. Then it must overlap the last complete observation's watermark under the V3 sort key: its oldest entry is not newer than `watermark(U)`. In that case `T` with `T_db` is complete.
   - **(c)** Otherwise, run the **full scan** (today's path) and reset `T_db` and the watermark from it.
4. Subscribe to `openOrders{U, dex}` for `dex ∈ T`. In steady state that is one subscription.
5. **Keep `userHistoricalOrders` subscribed until the read completes.** Any frame showing a new order on a dex outside `T` aborts with `live_account_observation_changed`, and the caller retries.
   - This is a *stronger* window than today. Today each venue is a point-in-time snapshot taken at a different moment.
6. **Emit the same `LiveAccountSnapshot`:**
   - `observedOrderDexes = listedDexes`. Unscoped dexes have `orders = []`, proven by history.
   - Add `coverage.orderProof = { method: 'history_scoped' | 'all_venues', scopedDexes, historyCount, watermark }` and fold it into `sourceDigest`.
   - Update the four downstream checkers (§1.2) to accept both methods explicitly, so a reviewer can see the semantic change.
   - Old readers ignore the extra field. The arrays keep their shape, so the change is mixed-version safe.
7. **Absence proof (setup):**
   - `allDexs` all zero, plus history **empty** (0 entries), proves no orders were ever placed on any dex.
   - Keep `openOrders{''}` as a belt-and-braces check.
   - The final `perpDexs` re-check stays (`copy-account-mode-evidence.ts:178-182`).
8. **Socket reuse.** With scoping, a read is about 3 subscribe and 3 unsubscribe messages. worker-copy should therefore keep a small pool (2–3) of long-lived account sockets per network instead of `closeAfterRead` sockets.
   - `closeAfterRead` was chosen to save messages when a read cost 270 (`live-account-ws-source.ts:128-132`).
   - Pooling cuts connects to about zero per read. Count users per socket against the 10-user cap.
9. **Detector (defense in depth).**
   - worker-read's snapshot collector runs a **full scan** of each live account every 30 min on IP B (`HL_DEX_SCOPING_AUDIT_MIN`).
   - It compares the result with the scoped proof. On any order or state on a dex outside `T_db` it alerts, sets the account to `pause_new_risk`, and disables scoping globally through the operational switch.
10. **Flag:** `HL_DEX_SCOPING=off|shadow|on`.
    - `shadow`: the snapshot collector runs both paths and logs mismatches. Orders keep the full scan.
    - `on`: orders, settlement, setup and snapshots use the scoped path, with full-scan fallback (3c).

**If V1 or V2 fails:** there is no cheap proof with the same guarantee on the public API. Fall back to the full scan and keep the other cuts: pooled sockets (−connects), snapshots moved to IP B, one process for the cache. Phase 3 (node) then becomes the way to make full scans cheap.

### 1.5 New estimates [est] (testnet, 2 accounts, scoping on, `T = {''}`)

| Operation | REST | WS msgs | Connects | Subs held |
|---|---|---|---|---|
| Order evidence, warm (incl. first order after a setup in the same process) | 69 | ~8 (~12 with pooled socket) | 2 (0 pooled) | ~6 |
| Order evidence, cold | 589 (REST history fallback: +40…240) | ~8 | 2 / 0 | ~6 |
| Settlement observation | 4 warm + ~67 | ~6–12 | 1 / 0 | ~3 |
| Account-mode step | 635 (unchanged) | ~8 | 2 / 0 | ~3 |
| Follower snapshot | 4 warm / 284 cold | ~6 | 1 / 0 | ~3 |

**Capacity on testnet IP A after scoping (per minute):**
- WS messages stop binding: about 150 orders/min.
- Connects: about 15 orders/min, or unbounded with pooled sockets.
- REST becomes the bound: about 140 per order including settlement, so about 8 orders/min. A 635 setup step is half a minute of the window.

REST reductions are not part of Phase 1. They are listed under §5.

---

## 2. Split egress by function

### 2.1 Today's wiring
- One image. `IS_WORKER` selects `AppModule.api()` or `AppModule.worker()` (`main.ts:49-57`, `app.module.ts:47-80`).
- `WorkerModule` imports every loop (`worker/worker.module.ts:27-45`).
- One lease for the worker: `pg_try_advisory_lock(73106, 1)` (`runtime/worker-lease.ts:7`), acquired in `bootstrap/worker.bootstrap.ts:80`.
- **Meter keys:**
  - `HYPERLIQUID_EGRESS_KEY` covers mainnet (`config/runtime-config.ts:415-422`).
  - `<key>:testnet` covers testnet (`hyperliquid/wallet-network-hyperliquid.ts:58-62`).
  - Every process uses the same keys, so there is one meter per HL host for the whole deployment.

### 2.2 Inventory of HL call sites by process

**api process (`AppModule.api()`):**

| Call site | Network | Kind | Target |
|---|---|---|---|
| Trader pages: `TradersService`, `TradeAnalyticsService` (analytics lane), `SpotPriceService`, `LeaderActivityService` via `HyperliquidInfoClient` (`hyperliquid-info.client.ts:252-254`) | mainnet | REST page/background | IP B or C (pages) |
| `TraderOrdersReader`, `TraderAccountReader`: all-venue WS (`traders/traders.module.ts:35-41`) | mainnet | WS, `1 + D_mainnet` subs per page | B/C (could adopt scoping later) |
| `TraderTwapReader`: WS `userTwapHistory` (`traders/trader-twap-reader.ts:108-138`) | mainnet | WS | B/C |
| Wallet pages: `WalletService` balances and ledgers (`wallet/wallet.service.ts:88-128`) | wallet network | REST page | B/C |
| **Withdrawals** `withdraw3` POST, browser-signed (`wallet/withdrawal.service.ts:116-157`, `withdrawal-exchange.client.ts:45`) | wallet | exchange POST | **A** (Phase 2, internal HTTP) |
| **Setup confirm**: deposit `usdSend` POST + **drive** (account mode 635, agent approval) (`copy/copy-live-setup.service.ts:469-492`; `funding.submit` `copy-funding.service.ts:97-145`; drive `:711`) | wallet | REST + WS + POST | Drive → **A in Phase 1** (DB/NOTIFY). Deposit POST → A in Phase 2 (internal HTTP) |
| **Setup advance** (`copy-live-setup.service.ts:575`): funding reconcile + drive | wallet | same | A (Phase 1) |
| **Account mode from Settings** (`CopyAccountModeController` → `copy-account-mode.service.ts:146-150,262`) | wallet | prepare/reconcile 102 REST; submit 635 + POST | Reconcile may stay a page read on B/C. Submit → A |
| **Agent approvals** (`copy-agent.service.ts:110-205`) | wallet | REST + POST | A |
| **Returns approve** POST (`copy-live-return.service.ts:61-94`) | wallet | POST | A (Phase 2, internal HTTP) |
| **API terminal settlement loop**, every 3 s, testnet (`copy-live-worker/copy-live-api-settlement.service.ts:26-29`; engine defers to it at `copy-live-engine.provider.ts:124`, `copy-live-engine.ts:465`) | testnet | REST + WS live | **A, Phase 1** |
| `HyperliquidAgentApprovalVerifier` used by authorization checks (`copy.module.ts:117-119`) | wallet | REST `extraAgents` 20 | B/C as a read (or A via delegation) |

**worker process (`AppModule.worker()`):**

| Job | Schedule | Network | Target worker |
|---|---|---|---|
| `CopyLiveWorkerService` (engine, stopper, closer, settler, setup tick + aborts, fast source) (`copy-live-worker.service.ts:50`; `copy-live-engine.provider.ts:65-136`) | `COPY_LIVE_INTERVAL_MS` | wallet + mainnet (fast source, reference) | **copy** |
| `CopyFundingMonitor` (`copy-funding-monitor.service.ts:16`) | 15 s | wallet | **copy** (money confirmations) |
| Setup driver `tick` (`copy-live-setup.service.ts:668`) and abandoned-approval reconcile | engine pass | wallet | **copy** |
| `WatcherModule` runtime: trade feed WS ~329 subs / 2 sockets (`watcher/trade-feed.service.ts:212`), watched refresh 15 s, copied catch-up 120 s (`watcher.service.ts:34-37,138-139`) | continuous | mainnet | **copy** (signal source; the fast source needs the in-process feed status, `copy-live-engine.provider.ts:116-118`) |
| `SchedulerService`: snapshots every 5 min, hourly sweep, catch-up at :15/:30/:45, backfill and feed check every minute (`scheduler.service.ts:59,96,110,116,127`) | cron | mainnet | **read** (feed check stays with the feed: copy) |
| `TradersWorker` history, leaderboard ingest, tracked (`traders-worker.module.ts:18,25,28`) | 1 min | mainnet | read |
| Discovery pool performance and ledgers, avatars (`discovery.module.ts:32-35`) | 1 min / 30 s | mainnet | read |
| Cohorts (`insights.module.ts:26`) | 1 min | mainnet | read |
| Revenue snapshot (`admin/revenue.module.ts:22`) | hourly | mainnet | read |
| `CopyFollowerSnapshotCollector` (`copy-follower-snapshot.service.ts:48`) | 15 s tick, 1 claim/min | wallet, **538 WS msgs** | **read** |
| `CopyFollowerMonitor` receipts (`copy-follower-monitor.service.ts:84`; background lane, `copy.module.ts:153-157`) | 60 s | wallet | read (reporting) |
| `CopyWorkerService` paper copy (`copy-worker.service.ts:42`) | 2 s | mainnet | read (**[verify]** it has no live path) |
| Archive ingest, retention, outbox, Telegram, rules seed | — | no HL | read |

### 2.3 What moves, and how
- **Setup drive (Phase 1, DB-driven).**
  - `confirm` and `advance` stop calling `drive()` (`copy-live-setup.service.ts:491,586`). They record the consent and set `nextAttemptAt = now()`, then `NOTIFY copy_setup_due, <id>`.
  - worker-copy LISTENs (the same pattern as `runtime/action-relay.ts`) and drives at once.
  - `answer()` already returns the current row after `answerMs` (`:589-598`), so the HTTP contract is unchanged.
  - Flag: `API_SETUP_DRIVE=local|worker`.
  - In Phase 1 the deposit POST stays in confirm. It weighs 1 and needs the in-memory signature.
- **API terminal settlement → worker-copy (Phase 1).**
  - Run `CopyLiveApiSettlementService` on worker-copy, or set `apiTerminalSettlement: false`.
  - Claims are DB-fenced (`copy-live-settlement-claim.ts`), so running both during the cutover is safe.
- **Signature-bearing owner actions (Phase 2, internal HTTP).** These are the deposit, withdrawal, return and Settings account-mode submit.
  - Signatures are deliberately never stored or logged (`copy-funding.service.ts:103`; `withdrawal.service.ts:111`). A DB queue would persist them, so it is rejected.
  - worker-copy exposes `POST /internal/exchange/{funding,withdrawal,return,account-mode}` on its private health server.
    - Auth is an HMAC key derived like `workerMonitorKey` (`runtime/worker-calls.ts:14-17`) with a new label. It is reachable only over Railway's private network (`WORKER_COPY_URL`).
    - The worker runs the *same* CAS-guarded service method.
  - If worker-copy is unreachable, the api answers the existing deferred or 503 path. It does **not** fall back to its own egress: that is the A invariant.
- **Worker-signed steps** (account mode during a setup, agent approval, aborts, auto-returns) are already DB rows driven by the worker. They need only NOTIFY wake-ups.

### 2.4 The in-memory scheduler for IP A (Phase 2)

One `HyperliquidEgress` per HL host (mainnet, testnet) in worker-copy. It implements the seam `BoundHyperliquidQuota` and `HyperliquidSocketQuota` (`postgres-hyperliquid-quota.ts:24-66`), so `HyperliquidGlobalTransport` keeps its API. Extract an interface: the constructor currently requires `instanceof PostgresHyperliquidQuota` (`hyperliquid-global-transport.ts:59-60`).

**Resources (sliding 60 s, exact send log, charges expire at send + 65 s like today):**
- REST 1200, with a working cap of 1140 (5 % margin).
- WS messages 2000 (cap 1800, as `live-account-ws-source.ts:36`).
- Connects 30 (cap 25).
- Concurrent connections 10, subscriptions 1000, unique users 10.

**Classes (strict order):**
- `live`: orders, closes, cancels, stops, settlement release, leader sources, live POSTs.
- `setup`: oldest setup first.
- `owner`: deposits, withdrawals, returns. A person is waiting and money is involved.
- `page`: only if A ever serves delegated reads.
- `background`: funding monitor and other copy reconciles.

**Requests:**
- `acquire({class, rest, msgs, connects, subs, users, key, deadline, signal})` returns a permit.
- `reserveBundle(...)` grants a whole step at once, e.g. an order's evidence or a setup's 635 + 2 connects. Sends draw the bundle down; `release()` returns what was not sent, which is exact in memory. This replaces `claimLive` / `claimSetup` / `releaseSetup` / holds (`hyperliquid-global-transport.ts:85-135`).

**Preemption:** a `live` request that does not fit revokes **untouched** lower-class bundles first: no send has happened, so no evidence clock is running. The revoked step gets `HyperliquidBudgetWait('local_budget', {preempted:true})` before its clock starts. A bundle whose clock has started is never revoked. This is the current meter's rule (`hyperliquid-global-quota.ts:439-449`) without SQL.

**Fairness floor:**
- Each lower class may consume at least a floor over the trailing 60 s: setup 240, owner 60, background 60, total ≤ 30 % of the cap.
- A request that waited longer than 5 s while its class is under its floor goes ahead of higher classes, once.
- Within a class, round-robin by owner userId (setup: FIFO by setup age).

**WS budget:**
- Long-lived holders (the trade feed on mainnet, pooled account sockets) register their connections and subscriptions as standing reservations.
- Per-read subscriptions are charged as messages and count against the user and subscription caps.
- Connect bursts are paced (≤ 25/min, ≤ 1 per 200 ms).

**429 handling:**
- On a REST 429 or WS rate error, mark the window full for `Retry-After` or 10 s, and lower the cap by 10 % (AIMD, +1 %/min back).
- Report `foreign_usage_suspected` when a 429 arrives with less than 80 % of the window used. Another process may be on the IP.

**Startup:**
- Seed the window from the last 65 s of the Postgres meter rows for the A keys (read only). The previous worker's sends still count at HL.
- Otherwise run at a 50 % cap for 65 s (the existing `startupPaceSeconds` idea, `runtime-config.ts:458`).

**Mapping of today's typed waits:**

| Today | In-memory scheduler |
|---|---|
| `reserveLive` / `liveBudget(lane:'live')` (`hyperliquid-budget-wait.ts:135,261`) | `acquire({class:'live'})`. The same `HyperliquidBudgetWait('local_budget')` on timeout; `HyperliquidBudgetOverCapacity` if the request exceeds the cap |
| `claimLive` + `runLive(token)` (`live-execution-runtime.ts:133-142,233,245`) | `reserveBundle({class:'live'})`. The token scopes the draws |
| `claimSetup` / `releaseSetup` / setup holds, `holdKey` queue place (`copy-account-mode.service.ts:166-168`) | `reserveBundle({class:'setup', key: setupId})`. The FIFO position is per key |
| `runBackground`, `fetchBackgroundInfo` / `fetchEssentialInfo` | `class:'background'` with `maxWaitMs` as today |
| `HyperliquidBudgetWait('shared_capacity')` | Not produced on A. Kept for B/C |
| `assertLiveEvidenceCapacity` (`live-shared-reads.ts:112-120`) | Checked against `cap − floors` |
| Per-process `RequestBudgeterService` wallet bucket (`wallet-network-hyperliquid.ts:58-65`) | Removed on worker-copy (the scheduler is the bucket) |

**IP B:**
- If the api has its own IP (C) and worker-read is alone on B, both run the same in-memory class. Then the Postgres meter is retired.
- If the api and worker-read share B, keep the Postgres meter for that key, reduced to the `page`/`background` lanes. The `setup`/`live` code paths become dead and are deleted in Phase 2.

---

## 3. Railway topology

| Service | Runs | Replicas | Egress | Env |
|---|---|---|---|---|
| web | Next | n | any | — |
| api | HTTP, pages, delegation client | 1 (the limiter and rate-limit docs assume a single replica: `docs/rate-limits.md`) | **C** (or B) | `HYPERLIQUID_EGRESS_KEY=<env>-C`, `API_SETUP_DRIVE=worker`, `API_TERMINAL_SETTLEMENT=off`, `WORKER_URL` (worker-copy), `WORKER_READ_URL` (worker-read) |
| worker-copy | live engine, setup driver, aborts, stops, funding monitor, settlement, watcher runtime (feed), fast source, exchange POSTs, **RulesModule** (alerts for the feed fast path are evaluated in-process: the actions the fast path stores reach the rules engine as in-process events, so it must run where the feed runs) | 1 active (lease `(73106,1)`) + standby during deploys | **A, static** | `IS_WORKER=true`, `WORKER_ROLE=copy`, `WORKER_TERMINAL_SETTLEMENT` (default `on` for `copy`), `HYPERLIQUID_EGRESS_KEY=<env>-A`, `HYPERLIQUID_EGRESS_BACKEND=memory` (Phase 2) |
| worker-read | scheduler crons, traders, discovery, cohorts, revenue, follower snapshots and receipts, paper copy, outbox, Telegram, retention, archive | 1 active (lease `(73106,2)`) | **B, static** | `IS_WORKER=true`, `WORKER_ROLE=read`, `HYPERLIQUID_EGRESS_KEY=<env>-B` |
| Postgres | — | — | — | — |

**Role and lease rules:**
- `WORKER_ROLE` unset means `all`. That is today's behaviour, and the process holds **both** leases.
- `copy` holds lease 1; `read` holds lease 2.
- So a new `read` service stays on standby until the old `all` worker is redeployed as `copy`.
- `AppModule.worker(role)` picks module sets. This needs splitting `WatcherModule` into capabilities (fill sync, account state, repositories) and runtime (`onApplicationBootstrap` start), so worker-read can use them without starting a second feed. `SchedulerModule` imports `WatcherModule` today (`scheduler.module.ts:11`).
- `COPY_LEADER_VERIFIED_EVENT` (a copied leader's catch-up finished, so its copy stream is audited) is an in-process event whose listener is on worker-copy. Only a started watcher emits it, so worker-read's sweeps do not; worker-copy's `catchUpCopied` (every 2 min) audits every watched copied leader.

**Flags (as built, 2026-10-14; each defaults to today's behaviour):**

| Flag | Process | Values | Effect |
|---|---|---|---|
| `WORKER_ROLE` | worker (refused on the api) | `all` (unset), `copy`, `read` | module set and leases: `all` holds `(73106,1)` and `(73106,2)`, `copy` lease 1, `read` lease 2; a role takes all its leases or none |
| `API_SETUP_DRIVE` | api | `local` (default), `worker` | `worker`: confirm and advance record, mark the setup due and `NOTIFY copy_setup_due`; worker-copy drives it (and reconciles the deposit). The api makes no Hyperliquid call for a setup step |
| `API_TERMINAL_SETTLEMENT` | api | `on` (default), `off` | the api's terminal settlement loop (testnet copy deployments only) |
| `WORKER_TERMINAL_SETTLEMENT` | worker | `on`/`off`; default `on` for `copy`, `off` for `all`; never on `read` | the same loop on worker-copy; claims are fenced in the database, so both may run during the cutover. Reported in the heartbeat's `worker.terminalSettlement` |
| `WORKER_URL` | api | URL | worker-copy (or the single `all` worker): /health's feed and the admin overview's `worker` |
| `WORKER_READ_URL` | api | URL, optional | worker-read. The api reads both heartbeats and merges them: snapshots, sweeps, discovery, archive and Telegram dry run come from worker-read. Unset: `WORKER_URL`'s heartbeat as it is |

**Guards (the api, `WorkerFleetService`; ALERT log lines at most every 10 min, and the admin overview's `alerts`):**
- `terminal_settlement_unowned`: on a testnet copy deployment with `API_TERMINAL_SETTLEMENT=off`, no copy (or `all`) worker heartbeat in the last 2 minutes reported its loop on. Then nothing settles terminal copies. Check this before turning the api's loop off.
- `snapshots_stale` (only with `WORKER_READ_URL`): worker-read's heartbeats have shown no snapshot for 15 minutes (it is down, on standby, or its snapshots fail).
- While a guard applies the api reads the workers itself every 30 s. Its start counts as the last good reading, so a restarted api waits a full window before it alerts.

**Egress identity guard:**
- At startup each process records `(service role, egress key, observed public IP)` in a `hl_egress_identity` table, using an optional IP echo behind a flag.
- It alerts, and in `copy` refuses to start, if one IP maps to two keys or one key to two IPs.
- A wrong key silently breaks the limiter.

**Railway features to verify on Paul's plan.** I couldn't access Railway from this session, so none of these are confirmed:
1. Static outbound IPs: available on the plan? Per service, or shared per project/environment?
2. Do replicas of one service share the IP?
3. IPv4 or IPv6? If IPv6, how does HL key its per-IP limits?
4. Is the IP stable across deploys and regions?
5. Today's default egress is a shared pool, possibly with other tenants. Unexplained 429s may come from strangers.

**If per-service static IPs are not available:** run worker-copy's HL traffic through a small forward proxy on a VM with a static IP, allow-listed to `*.hyperliquid*.xyz`. Use undici `ProxyAgent` for fetch and an agent for `ws`. Place it near Tokyo for latency.

---

## 4. Migration plan

### Phase 1a: dex scoping and role split (code, flags off by default)

Each step can be deployed alone.

**1. Verification spike (V1–V5).**
- Script under `scripts/copy-harness/` on testnet:
  - Place resting HIP-3 orders: limit, trigger, TP/SL, partially filled, by the agent and by the master.
  - Compare `historicalOrders`, `userHistoricalOrders` and per-dex `openOrders`.
  - Push one account past 2,000 orders to learn the cap and the sort key.
- Effort: 1–2 days.

**2. Scoped observer, `HL_DEX_SCOPING=shadow`.**
- Changes: the observer path, the history source in `live-account-ws-source.ts`, the `orderProof` field, the four checkers, `T_db` and watermark storage, pooled sockets.
- Tests:
  - Property test: random multi-dex account states. The scoped result must equal the full scan or refuse; it must never accept with a missing order.
  - Saturation and continuity tests.
  - A mid-read history frame on an unscoped dex aborts.
  - Old-reader parsing of new snapshots.
  - The absence proof with non-empty history refuses.
- Effort: 4–5 days.

**3. Role split** (`WORKER_ROLE`, two leases, WatcherModule split).
- Tests:
  - Extend `test/api-role-isolation.spec.ts`: `copy` constructs no scheduler, traders, discovery or cohort crons; `read` constructs no `LIVE_ENGINE`, exchange clients or setup driver; `all` matches today.
  - `scripts/worker-smoke.mjs`: `all`, `copy` and `read` lease hand-offs.
- Effort: 3 days.

**4. API delegation of the setup drive and the settlement loop** (`API_SETUP_DRIVE=worker`, settlement on worker-copy).
- Tests:
  - confirm and advance never call `drive`.
  - NOTIFY wake latency is under 1 s.
  - Settlement claims are not lost while both processes run.
- Effort: 2 days.

**Mixed-version notes:**
- Old and new workers both drive setups today under the per-setup DB lease, so overlap is safe.
- Snapshots keep their array shapes.
- `orderProof` is additive.

**Rollback:** `HL_DEX_SCOPING=off`; `API_SETUP_DRIVE=local`; scale worker-read to 0, then unset `WORKER_ROLE`.

### Phase 1b: egress split (infra) and scoping on

- Static IPs, or the proxy (A, B, optionally C), with distinct `HYPERLIQUID_EGRESS_KEY` per IP and the identity guard.
- Order: worker-read first (it moves background off the old shared key), then worker-copy.
- Then shadow scoping on worker-read's collector for at least 48 h, then `HL_DEX_SCOPING=on`.
- **Gate:**
  - 0 shadow mismatches over at least 500 observations, including deliberately HIP-3-dirty test accounts.
  - The copy harness gate that failed 7 times passes **3 consecutive runs** with `stage-like.env` background.
  - 0 `account_mode_absence_unproven` from socket refusals.
  - 0 live orders failed for capacity.
  - Setup p95 under 60 s. Order evidence wait p95 under 2 s.
  - Meter WS messages/min at or below 25 % on testnet A.
- Effort: 1–2 days plus the Railway verification.
- Rollback: set all services back to one egress key and turn scoping off.

### Phase 2: in-memory scheduler on worker-copy

1. **`HyperliquidEgress`** behind `HYPERLIQUID_EGRESS_BACKEND=memory|postgres` on worker-copy only.
   - Tests:
     - Simulator: no 60 s window ever exceeds a cap.
     - Priority, preemption only of untouched bundles, floors, deadlines, the users and subscriptions caps, 429 back-off, startup seeding.
     - Replay of the logged meter compositions from the seven failed gates.
   - Effort: 6–8 days.
2. **Internal exchange endpoint** and the api's signature-bearing POSTs routed to worker-copy.
   - Tests: auth, private-network only, idempotent CAS replay, the worker-down path answers deferred or 503, never local egress.
   - Effort: 2–3 days.
3. **Retire** lanes, claims, holds, `live_demand` and `setup_demand` from `hyperliquid-global-quota.ts:13-312` and the transport, once no process uses them on A. Remove worker-copy's wallet `RequestBudgeterService`. Optionally move B and C to memory if each is a single process.
   - Effort: 2–3 days.

**Mixed version:** the lease prevents two copy workers from sending at once. The new worker seeds from the old meter rows.

**Gate:**
- 24 h Stage soak with 0 HL 429s on A.
- Live evidence wait p99 under 2 s.
- The harness gate passes 3 runs.
- Heartbeat and admin overview show the scheduler state (replacing `hyperliquidLaneStatus`).

**Rollback:** `HYPERLIQUID_EGRESS_BACKEND=postgres` (keep the meter code until Phase 2.3 has soaked for a week).

### Phase 3: self-hosted node

- Use the existing plan (`docs/Hyperliquid 節點與索引計畫.md`, §0 and §1).
- The local info server has no weight limit and serves `clearinghouseState`, `openOrders`, `frontendOpenOrders`, `spotClearinghouseState`, `perpDexs`, `meta`, `userRole`, `extraAgents`, `userFees` and `activeAssetData`. It does **not** serve `userAbstraction`, `userDexAbstraction`, `allPerpMetas` or `metaAndAssetCtxs` (these stay on public A, mostly cached), nor any exchange POST (these stay on A).
- Use the node for the **full** per-dex order scan. That restores the all-venues proof at no rate cost and removes the dependence on V1–V4.
- Keep scoping as the fallback for when the node lags.
- Freshness: the existing provider-time checks (`live-account-observer.ts:349,458-462`) catch lag. Add a lag monitor and fail over to public A when lag exceeds 2 s.
- Tests: the node-doc probe (50 addresses × all dexes, field-by-field against the public API), lag injection, failover.
- Gate: 100 % parity over 7 days; evidence p99 unchanged.
- Effort: 2–4 weeks plus ops; host about US$400–600/month (per the node doc).

---

## 5. Further REST reductions (optional, after Phase 2)

- **Account-mode step (635).** Its absence-proof REST reads (perpDexs twice, spot, extraAgents) could share the observe's spot and perpDexs reads within one preflight. Saving ≤ 60.
- The `userRole` 60 is unavoidable before the role becomes `user`. Afterwards it is cached for 30 min.
- **Order cold path.** Pre-warm the read cache when a mandate activates (worker-copy, background class). The first order then pays 69 instead of 589.

---

## 6. Risks

1. **The history semantics (V1–V4) might be false or change silently.** Mitigations: shadow mode, the periodic full-scan audit with automatic pause and a global off-switch, and Phase 3.
2. **Wrong egress keys** (two keys on one IP, or one key on two IPs) silently break limiting. Mitigation: the identity guard.
3. **Railway static IPs** might be unavailable or shared. The fallback proxy adds a hop and a single point of failure.
4. **The 10-unique-users WS cap per IP** becomes the next ceiling. An owner with 8 accounts plus a leader nearly fills it. Pooled sockets must count users. Scaling to many concurrent followers will eventually need more IPs (sharded copy workers) or the node.
5. **A single worker-copy is a single point of failure for real money.** The standby takes over within the lease timeout (about 30 s, `worker-lease.ts:20`). Acceptable today; it rules out horizontal scaling of A without re-sharding.
6. **Delegating owner POSTs to worker-copy** couples withdrawals to worker health. Today they work while the worker is down.
7. **Shared default egress today** may include other tenants, so the measured gate failures may not all be self-inflicted.
8. **WatcherModule split:** a missed duplicate feed or a missing feed check would degrade signals.

## 7. Open questions for Paul

1. Railway plan: are static outbound IPs per service, per environment, or not available? Do replicas share? IPv4 or IPv6? Is a small proxy VM acceptable if needed?
2. Should the api get its own IP C? That retires the Postgres meter entirely. Or should it share B with worker-read, keeping a simplified meter?
3. Is it acceptable that withdrawals and deposits fail with "busy, retry" while worker-copy is down (Phase 2), instead of the api sending them itself?
4. May we spend testnet funds and orders on the V1–V4 experiments, including pushing one account past 2,000 orders?
5. What should the audit's automatic action on a mismatch be: `pause_new_risk` on the account and disable scoping globally, or alert only?
6. Should the watched-leader (favorites and alerts) fill sync later move to worker-read with its own trade feed? That takes more load off A but runs two feeds.
7. Paper copy (`CopyWorkerService`) goes to worker-read: please confirm that no live path depends on it.
8. What is the target scale (live accounts and orders/min at mainnet launch)? It decides when the 10-users cap forces sharding or the node.

### Critical files for implementation
- `apps/api/src/copy/live/live-account-observer.ts`
- `apps/api/src/copy/live/live-account-ws-source.ts`
- `apps/api/src/copy/copy-account-mode-evidence.ts`
- `apps/api/src/hyperliquid/hyperliquid-global-transport.ts` (with `postgres-hyperliquid-quota.ts:24-66`, the seam for the in-memory backend)
- `apps/api/src/app.module.ts` and `apps/api/src/bootstrap/worker.bootstrap.ts` (with `runtime/worker-lease.ts`, `worker/worker.module.ts`, `copy/copy-live-setup.service.ts:469-600`)

---

## 8. Revisions after review (2026-10-14, reviewer tracker §I) — override §1–§7 where they differ

**Facts found after the draft**
- **I-1 Mainnet has 11 perp dexes, testnet has 270.** The reviewer queried `perpDexs` on 10-14. A full-venue scan on mainnet is about 11 subscriptions and 14 messages, so §1 (scoping, V1–V4, shadow, audit, `T_db`) is a testnet-harness problem, not a mainnet one. **§1 moves off the mainnet critical path.** The testnet subscription overflow (1076 > 1000) is solved by the role split instead: once snapshots move to B, A carries the order (538) and the setup (269), 807 in total.
- **Railway static egress (checked with the Railway API, workspace plan PRO, Stage environment).**
  - Neither api nor worker has an egress gateway today, so both use the default shared egress.
  - The static-egress *preview* is **the same for both services**: HA `208.77.246.240/.241/.242` (sin, eqsg3a), legacy `208.77.246.15`.
  - So Railway static egress is a regional gateway, **not a per-service dedicated IP**. It is very likely shared with other Railway tenants in that region.
  - **Distinct, dedicated IPs for A and B therefore need our own forward proxy VMs** (§3 fallback), each with its own static IPv4. Run one per role, near Tokyo. That becomes the plan, not the fallback.
  - The default and the gateway egress may also carry other tenants' Hyperliquid traffic. This makes risk 7 concrete: some 429s or capacity loss may not be ours, and only our own IPs remove it.

**Design changes**
- **I-7 Phase 2.2 (internal HMAC HTTP for owner POSTs) is deleted.** Browser-signed `usdSend`/`withdraw3`/return use the owner's own signer nonce space, weigh 1 each, and stay on the api's egress. Only agent-signed actions must run on A, and those are already worker-driven DB rows. This removes risk 6. Paul also accepted the alternative ("busy, retry later" while worker-copy restarts), so either way is acceptable.
- **I-3** A setup's absence proof never becomes "history empty". Non-empty history means a full scan, not a refusal. Settings mode switches act on existing wallets that may have traded before.
- **I-2/I-4/I-5** These apply if §1 is ever built:
  - the baseline must be the WS initial snapshot (no REST baseline);
  - V3 must prove the list is a contiguous tail under its sort key;
  - a missing `T_db` forces a full scan;
  - `T_db` only ever grows.
- **I-6** Scheduler floors apply only while no live bundle is waiting. Mandate-activation pre-warm (first order pays 69, not 589) moves into Phase 2.
- **I-8** A standby worker-copy sends nothing to Hyperliquid until it holds lease 1. Add a worker-smoke check: the standby makes zero HL calls.
- **I-9** After Phase 2.3 the scheduler keeps its own persisted send log (or A's meter rows stay as a log only), so startup seeding has a source.

**Revised mainnet critical path (I-10)**
1. 1a-3 role split (`WORKER_ROLE`, two leases, WatcherModule split): about 3 days.
2. 1a-4 setup drive and API terminal settlement move to worker-copy (NOTIFY): about 2 days.
3. 1b egress split: two proxy VMs in Singapore with static IPv4 (A for worker-copy, B for worker-read), distinct `HYPERLIQUID_EGRESS_KEY`, the identity guard, `foreign_usage_suspected`. About 1–2 days, including the VMs.

Result: one process on A (setup and first order share a cache, and the local-bucket split problem disappears), snapshots and background off A, and no strangers on A.
Then Phase 2 (in-memory scheduler). §1 scoping and Phase 3 (node) come after mainnet.

**Paul's answers to §7 (2026-10-14)**
- Q1 static IPs: check with the Railway CLI. Done above: not per-service, so proxy VMs.
- Q3 owner POSTs refused while worker-copy restarts: acceptable. Moot after I-7.
- Q4 V1–V4 testnet experiments: allowed (only needed if §1 is built).
- Q2, Q5–Q8: still open.

**I-11 follow-up (2026-10-14): run worker-copy on the VM, or proxy through it?**

| | Worker on the VM | Railway worker → proxy VM → HL |
|---|---|---|
| DB round trips | The order path is about 125 sequential round trips to Railway Postgres (Singapore). The VM reaches it only through Railway's public TCP proxy over the internet. From Tokyo (about 70 ms RTT) that is about 9 s per order, so the 5 s window is impossible. From Singapore it is a few ms plus public-internet jitter, with TLS and a public DB endpoint to secure. | Stays on Railway's private network (about 8 ms, as measured by the gate) |
| HL latency | VM → HL | Railway (Singapore) → proxy → HL. An extra hop of about 1–2 ms if the proxy sits in the same Singapore region as Railway. Today traffic already goes Singapore → HL. |
| Deploy | A second pipeline (image pull, systemd/docker, secrets) outside `railway up`. The guard scripts and the lease hand-off need rework. | Unchanged. The proxy is a static, rarely changed process (tinyproxy/squid with an allow-list) |
| Failure points | VM + worker | VM + proxy process. The VM is already a single point of failure in both. |

**Decision:** keep the workers on Railway and put the **proxy VMs in Singapore** (the same metro as Railway's `asia-southeast1`), not Tokyo. The extra hop is only Singapore → Singapore, and DB latency stays private. Watch proxy health: the egress identity guard plus a heartbeat field `proxyReachable`. If the proxy is down, worker-copy refuses to start or fails closed; it never falls back to Railway's shared egress.

**I-12** `foreign_usage_suspected` (an HL 429 while our own window usage is below 80 %) ships in **1b**, not Phase 2. It should go to zero after the move to our own IPs; that is the only evidence for or against risk 7.

**I-13 (2026-10-14) Correction: the egress split alone does not remove "an order in the same minute as a setup's mode step waits".** After the split, the setup and the order both run on worker-copy's IP A and still share 1200. What removes the wait is **1a-4**: the setup drive moves into worker-copy, so the first order's read cache is warm (69 + boundary), and 635 + 69 fits. Do not count this as fixed after 1b alone.

**I-14** The `live_standby` marker (c8e8f7d7) should hold the current mandate's *actual* heaviest need: about 385 for one account cold, or about 69 plus the boundary once the cache is warm. It currently holds the startup bound of 793, which leaves two thirds of the window idle. Fix this in the next batch; also show the setup bucket in the heartbeat and admin.

**I-15 (2026-10-14) Railway only.** Paul uses Railway alone, so there are no external VMs and the proxy plan is dropped. Revised 1b:
- Enable Railway static egress (the HA gateway, `208.77.246.240–242`, sin) on **worker-copy only**.
- The api and worker-read stay on Railway's default egress. Our own background and page traffic then leaves IP A.
- Railway's docs say the gateway "may be shared with other customers". `foreign_usage_suspected` measures this. If it is non-zero, the next step is to move worker-read (or worker-copy) to another Railway region so it gets a different pool.
- The identity guard compares the public IP each role observes and refuses to start worker-copy when its IP equals the api's or worker-read's.
- Rollback: `egressGatewayAssociationsClear` on the service.
