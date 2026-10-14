# Phase 2 design: in-memory Hyperliquid egress scheduler on worker-copy (2026-10-15)

> Status: design only. No code was changed. Line numbers refer to `HEAD` = `1cb76f76`.
> Save as `docs/design-hl-scheduler-phase2-2026-10-15.md`.
> Inputs:
> - `docs/design-hl-egress-2026-10-13.md` §2.4. §8 (I-1…I-17) overrides it where they differ.
> - `docs/egress-subtraction-inventory-2026-10-15.md`: D1–D12 are the acceptance condition; the §1.2 safety items stay.
>
> Ground rules taken from §8:
> - Railway only, with no proxy VMs (I-15).
> - Owner POSTs stay on the api (I-7).
> - The role split and the leases are done.
> - Floors apply only while no live work waits (I-6).
> - A standby makes no Hyperliquid call until it holds its lease (I-8).
> - The persisted send log is the seeding source (I-9).

---

## 0. Summary

1. **One `HyperliquidEgress` object per egress key per process.** It keeps an exact sliding 60 s log of everything this process sends, plus the concurrent socket resources. It admits work in five strict classes: `live > setup > owner > page > background`.
2. **It sits behind an extracted `HyperliquidQuotaBackend` interface.** `PostgresHyperliquidQuota` and a new `MemoryHyperliquidQuota` both implement it.
 - `HyperliquidGlobalTransport` keeps its public API. Only its constructor's `instanceof PostgresHyperliquidQuota` check changes (`hyperliquid-global-transport.ts:60-64`).
 - The two seams stay type-compatible: `BoundHyperliquidQuota` and `HyperliquidSocketQuota` (`postgres-hyperliquid-quota.ts:29-68`).
3. **Bundles replace all the lane machinery.** A step reserves its whole demand at once with `reserveBundle` (an order's evidence, or a setup's 635 + 2 connects). Its sends draw the bundle down, and `release()` returns the unsent part exactly.
 - Bundles replace the claims, grant holds, demand tickets, standby tickets, local keyed holds and the double charge: today a read is charged once to the local bucket and again to the shared meter.
 - **Preemption** only revokes bundles that no send has touched yet.
4. **Persisted send log.** A new append-only table, `hyperliquid_egress_sends`, is written asynchronously and kept for 10 minutes.
 - On lease takeover the scheduler seeds its window from the log and from any live rows of the old meter.
 - With neither source it runs at 50 % for 65 s.
 - A standby constructs nothing, so it makes zero calls by construction (`worker.bootstrap.ts:60-72,121-124`).
5. **Recommendation: retire the Postgres meter everywhere.** On Stage, api, worker-copy and worker-read already egress from three distinct IPs (I-17), and each is a single process, so each runs its own memory scheduler. The identity guard plus AIMD cover a future overlap.
 - The D1–D12 deletion lands in the same merge as the scheduler.
 - A *plain* Postgres meter (a sliding window with no classes) is kept for one week as an emergency rollback backend, then removed.
6. **About 18 engineer-days, in 13 commits.** Every commit passes the full suite.

---

## 1. The `HyperliquidEgress` interface

### 1.1 Resource model (per egress key, i.e. per IP and HL host)

| Resource | Kind | Nominal | Working cap | Source of the number |
|---|---|---|---|---|
| REST weight | 60 s sliding window | 1200 | **1140** (5 %) | HL docs; `hyperliquid-global-quota.ts:68` |
| WS messages sent | 60 s sliding window | 2000 | **1800** | `live-account-ws-source.ts:36`; quota `:424` |
| WS connects | 60 s sliding window | 30 | **25**, and at most 1 per 200 ms | quota `:424` |
| Open connections | concurrent | 10 | 10 | quota `:570` |
| Subscriptions | concurrent | 1000 | 1000 | quota `:570` |
| Unique users (`network:user` over all subscriptions) | concurrent | 10 | 10 | quota `:571` |

How windowed charges work:
- A windowed charge is stamped with `expiresAt = min(sendUntil, dispatchedAt + 1000) + 60_000`. This is at most `acquiredAt + 65_000`, the same bound as `REST_CHARGE_LIFETIME_MS` (`hyperliquid-capacity-error.ts:6`).
- A charge whose permit is never dispatched stays charged until its expiry. This conservative no-refund rule is unchanged.
- A list's settlement (`settleListAnswer`, transport `:50-53`) lowers the charge in place at once. There is no "ride on the next request" any more (`postgres-hyperliquid-quota.ts:112-120`).

How concurrent resources work:
- They are held from `reserveSocket` until the socket's `close` event, or until the process exits (the kernel closes the TCP).
- There is no stale-lease reclaim on A. `HYPERLIQUID_STALE_LEASE_RECLAIM_MS` (quota `:412`) only exists for a persisted, multi-process meter.

### 1.2 Types (new file `apps/api/src/hyperliquid/egress/hyperliquid-egress.ts`)

```ts
export type EgressClass = 'live' | 'setup' | 'owner' | 'page' | 'background';
export const EGRESS_CLASS_ORDER: readonly EgressClass[] = ['live', 'setup', 'owner', 'page', 'background'];

/** Windowed units (REST weight, WS messages, WS connects) and concurrent units. */
export interface EgressDemand {
readonly rest?: number; readonly msgs?: number; readonly connects?: number;
readonly connections?: number; readonly subscriptions?: number;
/** `network:0x…` users whose subscriptions this demand adds (counted once each). */
readonly users?: readonly string[];
}
export interface EgressRequest extends EgressDemand {
readonly class: EgressClass;
/** Queue identity. setup: the setup id (FIFO by `since`); owner/page/background: the userId (round-robin); live: none (FIFO by arrival). */
readonly key?: string;
/** setup only: the setup's age (confirmedAt, ms). FIFO order is by this, so it is the same across passes and restarts. */
readonly since?: number;
/** Wall-clock ms after which the request gives up with HyperliquidBudgetWait('local_budget'). */
readonly deadline: number;
readonly signal?: AbortSignal;
}
export interface EgressPermit {            // one send; same contract as HyperliquidSendPermit
assertFresh(): void;
dispatch<T>(work: () => T): T;           // one use; fence ≤ 5 s
settle?(units: number): void;            // REST list only; lowers, never raises
}
export interface EgressBundle {
readonly id: string; readonly class: EgressClass; readonly key?: string;
/** True once any unit was drawn: never revocable from then on. */
readonly touched: boolean;
readonly remaining: Readonly<Required<Omit<EgressDemand, 'users'>>>;
/** Aborts when the scheduler revokes this (untouched) bundle; reason = HyperliquidBudgetWait. */
readonly revoked: AbortSignal;
/** Takes `d` from what is left. Synchronous (sets `touched`). False when not enough is left. */
draw(d: EgressDemand): boolean;
/** Reserves more into this bundle at its class's priority (live inside a clock: deadline ≤ now + 1 s). */
extend(d: EgressDemand, deadline: number): Promise<void>;
/** Gives back what was not drawn (exact). Idempotent. */
release(): void;
/** Runs `work` with this bundle as the EgressScope: sends inside it draw from it first. */
run<T>(work: () => Promise<T>): Promise<T>;
}
export interface EgressSocketRequest extends Omit<EgressRequest, keyof EgressDemand> {
/** A long-lived holder (the trade feed): shown as a standing reservation; never preempted. */
readonly standing?: boolean;
}
export interface HyperliquidEgress {
readonly egressKey: string;
acquire(request: EgressRequest): Promise<EgressPermit>;
reserveBundle(request: EgressRequest): Promise<EgressBundle>;
release(bundle: EgressBundle): void;               // = bundle.release()
/** Revokes an untouched bundle (preemption, lease loss, tests). False if touched or gone. */
revoke(bundleId: string, reason: 'preempted' | 'shutdown'): boolean;
/** What live orders need kept free now (I-14: liveStandbyNeed). Lower classes, floors included, see cap − this. */
setLiveStandby(need: EgressDemand): void;
/** A connect permit and its socket accounting (subscribe/unsubscribe/ping/close as HyperliquidSocketQuota). */
reserveSocket(request: EgressSocketRequest, network: LiveNetwork): Promise<{ connect: EgressPermit; connection: HyperliquidSocketQuota }>;
/** HL refused us for its rate limit (REST 429 or a WS rate-limit error). Applies AIMD and returns our own window use (0..1). */
noteRateLimited(kind: 'rest' | 'ws', retryAfterMs?: number): number;
/** Our own sent units in the trailing 60 s ÷ nominal (foreign_usage_suspected). */
windowUse(kind: 'rest' | 'ws'): number;
status(): EgressStatus;                            // heartbeat and admin; replaces D7
}
```

### 1.3 How it plugs in

**Extracted interface** (in `postgres-hyperliquid-quota.ts`, or a new `hyperliquid-quota-backend.ts`):

```ts
export interface HyperliquidQuotaBackend {
bindUnscoped(identity: HyperliquidQuotaBinding): BoundHyperliquidQuota;
bindOriginal(session: LiveRiskDatabaseSession, identity: HyperliquidQuotaBinding): BoundHyperliquidQuota;
/** Our own share of the window (foreign usage). Replaces meterSnapshot in transport.noteRateLimited (:156-161). */
windowUse(egressKey: string, kind: 'rest' | 'ws'): Promise<number | undefined>;
status(egressKey: string): Promise<EgressStatus | undefined>;   // replaces laneStatus / meterSnapshot (:146-160)
}
```

The transport constructor:
- `hyperliquid-global-transport.ts:60-64` keeps its anti-forgery intent with a module-private brand: `isQuotaBackend(q)` checks a `WeakSet` that both backend constructors register into. A plain object still fails with `hyperliquid_quota_invalid`.
- The rest of the transport's API is unchanged: `fetchInfo`, `fetchPageInfo`, `fetchBackgroundInfo`, `fetchEssentialInfo`, `fetchAnalyticsInfo`, `fetchInfoBatch`, `fetchBackgroundInfoBatch`, `acquireExchange`, `fetchExplorer`, `runOriginal`, `currentQuota`, `noteWsError`.

`MemoryHyperliquidQuota implements HyperliquidQuotaBackend` holds `Map<egressKey, HyperliquidEgress>`, created lazily after seeding (§3).

- `bindUnscoped(...)` returns a `BoundHyperliquidQuota` whose methods behave as follows:
- **`acquireRest(weight, deadline, lane?, options?)`**
  - **Class:** `lane` is mapped to a class, with `'owner'` added to `HyperliquidRestLane`. When there is no lane, the class comes from the current `EgressScope` (ALS), else `options.fallback`, else `background`. This is the same precedence as `postgres-hyperliquid-quota.ts:274-275`.
  - **Draw order:** the scope's bundle first; then the per-class *credit pool* (§1.4); else `egress.acquire({class, rest: weight, deadline: min(deadline, caller's maxWait)})`.
  - **Inside an original session:** the wait is 0, so an overflow throws `HyperliquidRestCapacityError(estimate)` exactly as today. No budget wait ever runs inside the 5 s evidence clock.
- **`reserveSocket(deadline, network, opts?)`:** the connect is drawn from the scope's bundle when there is one. `opts.standing` is new and is passed by `trade-feed.service.ts:214`.
- **Socket accounting:** `HyperliquidSocketQuota`'s `subscribe`, `unsubscribe`, `ping`, `close`, `renew` and `whenIdle` keep the permit and command-permit semantics of `postgres-hyperliquid-quota.ts:339-436` (one use, fenced, command identity matched). They charge messages and concurrent units in memory. The TLS/EOF proof logic is kept as the condition for releasing concurrent units: a socket that ends uncertain keeps its connection/subscription/user units until its `close` event.
- **Removed:** `claimSetupRest`, `releaseSetupRest`, `claimLiveRest` and `standbyLiveRest` are not implemented and are deleted from the interface in C10.
- `bindOriginal(session, …)` still calls `assertOriginalLiveRiskSession` and keeps the per-session queue. It runs **no SQL**. This removes the 12-statement quota transaction from every charge inside the order's 5 s window (`postgres-hyperliquid-quota.ts:192-201` documents 2.3 s of 2.4 s at 8 ms RTT). This is a large latency gain for the I-6 path.

### 1.4 Scopes and the credit pool (what replaces `liveBudget` / `reserveLive`)

Many clients take a `LiveBudget` callback before reading: observers, the resolver, providers, the settler, the closer, the stopper, the source client, the funding client (`copy.module.ts:110,130,132,142,150`; `copy-live-engine.provider.ts:92,99`). On the memory backend a single factory, `egressBudget(egress, {class, maxWaitMs})`, returns the same `LiveBudget` shape:

- **Inside an `EgressScope`** (a live order: `bundle.run`; a setup step: `bundle.run`): `budget(w)` calls `scope.bundle.extend({rest: w}, now + maxWaitMs)`. A later `adjust(-w)` releases from it.
- **Outside a scope:** `budget(w)` reserves a bundle of `w` at the factory's class and pushes it onto that egress's FIFO **credit pool** for the class. The next unscoped `acquireRest` of that class draws from the oldest credit first. A credit not drawn within 10 s is released.
- Totals stay exact: reserved before equals charged after, and reserved units count against the window.
- Only which caller's send consumes which credit can change, and that does not matter within one class.
- `HyperliquidBudgetOverCapacity` (`hyperliquid-budget-wait.ts:60-62`) is thrown at once when a demand exceeds what its class can ever hold. For `live` that is the working cap. For other classes it is the working cap minus the live standby.

The process's `RequestBudgeterService` on worker-copy, for the mainnet `HyperliquidInfoClient` and the wallet bucket, becomes `EgressPassThroughBudget`:
- `acquire` resolves at once, because the transport admission is the real one.
- `introspect`, `queued` and `liveCapacity` come from `egress.status()`.
- `onRateLimited` delegates to `egress.noteRateLimited`.

This is D9's "no local bucket on worker-copy" without touching the api's page-rank logic (L1 stays for the api and worker-read).

---

## 2. Classes, admission, preemption, floors, deadlines

### 2.1 Class assignment on worker-copy

| Class | Work |
|---|---|
| `live` | `LiveExecutionRuntime` (evidence, epoch reads, risk gates, POST); `CopyLiveSettler` and the terminal settlement loop; `ReduceOnlyCloser`, `StopCanceller` and `CopyLiveStopper`'s closes; auto-return; `HyperliquidLiveSourceClient` (testnet leader); `FastMainnetSource` (`info.userFillsSince(...,'live')`); `MainnetSourceReferenceReader`; `HyperliquidAgentApprovalVerifier` for orders; live leverage updates; the trade feed's sockets (standing); `fetchExplorer` |
| `setup` | `SetupSteps` funded → mode_set → agent_active → builder (account-mode client, absence reader, agent client, builder fee read), all inside the step's bundle |
| `owner` | The setup-abort saga (refund proofs and returns: the owner's money, the owner waiting). The api's deposit, withdrawal, return and Settings account-mode on the api's own egress |
| `page` | None on A (I-7). The api's trader and wallet pages |
| `background` | `CopyFundingMonitor`, abandoned-approval reconcile (`copy-live-setup-driver.ts:86`), watcher refresh and copied catch-up (essential: waits up to 15 s), market catalog, and the mandate pre-warm (I-6) |

### 2.2 Admission algorithm (one `pump()`, run on every request, release, dispatch, timer and 429)

Notation:
- `used(r)` is the window sum of resource `r` (sent plus not yet expired).
- `held(r)` is what live bundles still hold, undrawn.
- `cap(r)` is the working cap × the AIMD factor × the startup factor.
- `S` is `setLiveStandby`.

A request of class `c` fits when, for every resource:

```
used + held + demand ≤ cap               (c = live)
used + held + demand ≤ cap − S           (c ≠ live)
```

The scan for each pump:
1. **Live first, FIFO.** If the head fits, admit it. If it does not, try preemption (§2.3). If it still does not fit, *stop admitting every lower class except by backfill (rule 3)*. The freed room is the live head's. This is the rule whose absence caused the 08:18 gate: "every unit that freed up was taken".
2. **Then the classes in strict order.** Within a class:
 - `setup`: FIFO by `since` (setup age).
 - `owner`, `page`, `background`: round-robin over `key` (userId), FIFO within a key.

 The first head that fits is admitted. A head that does not fit becomes the *blocking head*.
3. **Backfill.** A request behind a blocking head (in its own class or any lower class) is admitted only if it fits beside the blocking head's whole demand, i.e. `used + held + headDemand + demand ≤ cap(−S)`. A small read never delays a waiting big step.
4. **Floors** (I-6: *only while no live request is queued and no live bundle is extending*):

 | Class | Floor (REST units, trailing 60 s) |
 |---|---|
 | `setup` | 240 |
 | `owner` | 30 |
 | `background` | 30 |
 | `page` | 0 on A (60 on the api, where there is no live class) |

 - The total is 300, i.e. 25 % of 1200. It is *not* the 30 % of §2.4: see the check below.
 - A head of class `c` that has waited more than 5 s while `c`'s trailing-60 s consumption is under its floor is admitted ahead of the higher classes, once, if it fits within `cap − S`. Its next request waits again.

**Why 300, not 360:**
- Floors may already have been consumed just before an order arrives, and sent units are never preempted. An order is therefore guaranteed `cap − floors`.
- The startup bound (two accounts plus the leader, cold) is 793 (`live-shared-reads.ts:112-120`; design §1.1).
- `1140 − 300 = 840 ≥ 793`, while `1140 − 360 = 780` does not fit.
- `assertLiveEvidenceCapacity` is therefore re-based to `cap − Σfloors = 840`. Three accounts plus the leader (997) is refused at startup, as today's 900 bucket refuses it (`live-order-budget.spec.ts:73`).
- The standby `S` is always honoured by floors too. An order of the standby's size therefore fits at once.

### 2.3 Preemption (only untouched bundles)

When the live head does not fit:
1. Compute the shortfall per resource.
2. List the *untouched* bundles of lower classes, ordered `background`, then `page`, then `owner`, then `setup`, newest first within a class. Standing sockets are never on this list.
3. Take the shortest prefix whose release covers the shortfall.
4. If even all untouched bundles together do not cover it, revoke **nothing**, so no step is aborted without a gain.

Otherwise each chosen bundle:
- has `revoked` aborted with `HyperliquidBudgetWait(retryMs, 'local_budget', {preempted: true})`, where `retryMs = max(1000, estimate until it fits again)`;
- has its holdings returned to the pool;
- has its next `draw`, `extend` or scope send throw that wait.

`touched` is set synchronously by the first draw, and the scheduler runs in one thread, so there is no race. A bundle whose step has sent anything is never revoked. This is the current rule (`hyperliquid-global-quota.ts:477-487`) without its second "all grants" pass: real money no longer needs to abort a running step, because the standby and the floors bound are sized for it.

### 2.4 Deadlines and the setup's place

| Caller | Deadline | On expiry |
|---|---|---|
| Live order prepay (before SQL locks) | `min(signalDeadline, now + LIVE_RESERVE_WAIT_MS 8 s)`, as at `live-execution-runtime.ts:134` | `HyperliquidBudgetWait('local_budget', {class:'live', need})` |
| Live inside an evidence clock (`bindOriginal`, an in-scope overflow) | `now + 0` (REST) / `IN_WINDOW_METER_WAIT_MS` 1 s (`copy-account-mode.service.ts:132`) | `HyperliquidRestCapacityError(estimate)`: `hyperliquid_quota_exhausted`, class budget |
| Setup step | `stepBudgetMs.reserveWaitMs` (`copy.module.ts:95-96`) | `HyperliquidBudgetWait('local_budget')`, `retryMs = clamp(estimate, 1 s, 20 s)` |
| Owner (api) | 10 s (today's `withdrawal-exchange.client.ts:30`, `copy-funding-exchange.client.ts:37`) | the same |
| Page | `PAGE_CAPACITY_WAIT_MS` 6 s | the same; the page answers 503 as today |
| Background / essential / analytics | 0 / 15 s / 130 s (transport `:21-37`) | the same |

**A setup's place across passes.**
- The setup driver's pass blocks the engine's pass, so a setup cannot wait in the queue for long.
- When its deadline expires, the request is removed but leaves a **ghost**: its `{since, demand}` stays in the setup queue for `min(retryMs + 5 s, 30 s)`.
- Admission treats a ghost as a waiting head for rules 1–3. Lower classes leave its demand free, and its next pass (same `key`) takes over the ghost's position.
- Because order is by `since` (the setup's `confirmedAt`), not by arrival, the place is also correct after a restart.
- This is the whole replacement for `setup-demand:`, `pendingSetups`, `queue:true`, `holdKey`, `park()` and `LIVE_YIELD_RANK` (D3, D8).

### 2.5 Mapping of today's waits and codes

| Today | After |
|---|---|
| `reserveLive` / `liveBudget(lane:'live')` (`hyperliquid-budget-wait.ts:138-156,273-284`) | `egressBudget(egress, {class})`: `bundle.extend` in scope, else a credit-pool reservation. Waits give `HyperliquidBudgetWait('local_budget')`; over-cap gives `HyperliquidBudgetOverCapacity` (`live_budget_over_capacity`, permanent, `error-class.ts:82`) |
| `claimLive` + `runLive(token)` (`live-execution-runtime.ts:133-142,233,245`; transport `:116-128,149`) | `const b = await egress.reserveBundle({class:'live', rest: weight, deadline})`, then `b.run(() => scope.run(...))`, then `finally b.release()`. A busy risk lock (`live_risk_busy`) releases the untouched bundle *exactly*; today the meter cannot refund |
| `standbyLive` / `live-standby:` / `LIVE_STANDBY_RENEW_MS` (`copy-live-engine.ts:92,180-189`; provider `:130`) | `egress.setLiveStandby({rest: liveStandbyNeed(...)})`, called every pass. It is a number, not a ticket. `live-standby-need.ts` stays |
| `claimSetup` / `releaseSetup` / `withCapacity` / grant holds / `holdKey` (`copy-live-setup-steps.ts:157-202`) | one `reserveBundle({class:'setup', key: setupId, since: confirmedAt, rest, connects})` per step; `bundle.run(step)`; `release()` in `finally` |
| `runBackground`, `fetchBackgroundInfo` / `fetchEssentialInfo` | `class:'background'` with the same `maxWaitMs` |
| `HyperliquidBudgetWait('shared_capacity')` (`:47`; `sharedCapacityWait` `:68-76`) | never produced by the memory backend. Deleted in C12 (D11) |
| `hyperliquid_quota_exhausted` (`error-class.ts:56`) | kept, from in-clock overflows; still class `budget`. The retry becomes `clamp(retryAfterMs + 250, 1 s, 65 s)` from a small helper `meterRetryMs` in `hyperliquid-capacity-error.ts`, replacing `sharedCapacityWait` at `error-class.ts:179` |
| `hyperliquid_quota_queue_full` (`:58`) | kept: a class queue over 256 |
| `hyperliquid_quota_subscriptions` / `_users` / `_connections` (quota `:570-571`) | memory: a socket request waits for concurrent units (they free when sockets close) up to its deadline, then `HyperliquidBudgetWait('local_budget', {resource})`. A demand that can never fit (e.g. 11 users) gives `HyperliquidBudgetOverCapacity` |
| `live_risk_busy` (`error-class.ts:66`, 1 s) | unchanged (an SQL advisory lock, not egress). The bundle is released on it |
| new `hyperliquid_egress_inactive` (a send before seeding, or after shutdown began) | `BUDGET_CODES` with 5 s. It should never be seen, because a standby constructs nothing |
| `assertLiveEvidenceCapacity` (`live-shared-reads.ts:112-120`) | checked against `cap − Σfloors` (840) |
| `assertBucketHolds` (`hyperliquid-budget-wait.ts:291-293`; `copy.module.ts:125`) | deleted. The setup's 635 + 2 connects ≤ `cap − S` is asserted at startup instead |

**`decideRetry` (`error-class.ts:264-281`) stays the one retry policy.**
- Only its inputs change: one budget reason, and `meterRetryMs`.
- `PROVIDER_READ_FAILURES` and the `hyperliquid_quota_` prefix rule (`:277`) are unchanged.
- `WRAPPING_CODES` still lifts an observer refusal whose `cause` is a `HyperliquidBudgetWait` to `budget` (`:168-171`).

**`HyperliquidBudgetWait.detail` (D12)** becomes `{class?, need?: {rest,msgs,connects}, preempted?: true, retryAfterMs}`.
- `last_wait` (`db.ts:2063-2066`, written at `copy-live-setup-driver.ts:164-168`) becomes `{at, step, reason: 'local_budget' | 'awaiting_credit', retryMs, waits, preempted?, class?, alertedAt?}`.
- `bucket`, `tokens`, `queued` and `lane` are dropped from the type. Old rows keep the extra keys (jsonb, diagnostics only). No SQL migration is needed.

---

## 3. Startup, failover and the send log

### 3.1 Table: migration `0086_hyperliquid_egress_sends.sql`

```sql
create table hyperliquid_egress_sends (
id bigserial primary key,
egress_key text not null check (length(egress_key) between 1 and 160),
holder text not null,                -- process ownerId (randomUUID per process)
at timestamptz not null,             -- dispatch (or reservation, for undispatched permits)
expires_at timestamptz not null,     -- as in memory: ≤ at + 65 s
kind text not null check (kind in ('rest','ws_message','ws_connect','ws_open','ws_close','clean_stop')),
units integer not null check (units between 0 and 2000),
class text not null check (class in ('live','setup','owner','page','background'))
);
create index hyperliquid_egress_sends_key_at_idx on hyperliquid_egress_sends (egress_key, at);
```

Writing it:
- Rows are written by an async flusher every 250 ms or 64 rows, whichever comes first. The flusher uses its own pool connection and is **never on the send path**.
- `ws_open` and `ws_close` rows (units = the socket's subscriptions; users are not stored) let a successor know about sockets the predecessor still had open.
- `clean_stop` is written by graceful shutdown after the jobs stop and before the lease is released. The order is jobs, then flush, then `clean_stop`, then lease release. This fits `worker.bootstrap.ts:103-109`'s order.
- Retention: the active holder deletes `at < now() − 10 min` every minute (`delete … where egress_key = $1 and at < …`, bounded by `limit 5000` in a CTE).
- The table is added to `RETENTION_TABLES` only as documentation. The scheduler's own sweep does the work.
- Alternative considered: reusing `hyperliquid_egress_quota.events` as a log. It is rejected: every append rewrites one jsonb row of at most 4096 events (`db.ts:2140-2145`) under a row lock, which is the contention this phase removes.

### 3.2 Seeding (lease takeover)

The `HyperliquidEgress` provider is an async Nest factory. It is constructed only after the role's lease is held, because the standby constructs nothing (`worker.bootstrap.ts:60-72`). Before the egress exists:

1. It reads `hyperliquid_egress_sends where egress_key=$1 and expires_at > now()`.
2. It also reads the old meter's row (`hyperliquid_egress_quota.events` alive). This is mixed-version safety for the first deploy and for a rollback in either direction.
 - It skips never-sent markers and holds: the prefixes `setup-demand:`, `live-demand:`, `live-standby:` and `setup-hold:` (quota `:93-99,253-254,281`).
 - It dedupes with the log by time, by taking the per-kind *maximum* of the two sums per 1 s bucket rather than their sum: the same send may be in both.
3. It adds open sockets: `ws_open` rows without a matching `ws_close`, from a holder without `clean_stop`, counted as connections and subscriptions until `at + 60 s`. HL closes an idle connection after 60 s, and the old process's sockets died with it.
4. It applies the factors:

 | Case | Seed | Startup factor |
 |---|---|---|
 | Log present, predecessor wrote `clean_stop` | exact | 1.0 |
 | Log present, no `clean_stop` (crash) | exact | 0.9 for 65 s (covers one unflushed buffer) |
 | No log rows and no live meter rows | none | **0.5 for 65 s** (the `startupPaceSeconds` idea, `runtime-config.ts:497`) |

5. It logs `egress_seeded {key, from: 'log'|'meter'|'both'|'none', rest, msgs, connects, sockets, factor}`.

### 3.3 Lease loss and standby

- Lease loss exits the process (`worker.bootstrap.ts:71`). Untouched bundles die with it, nothing is persisted as held, and the kernel closes the sockets.
- **Standby: zero calls.** Nothing constructs the egress, so any construction path that tried to send would hit `hyperliquid_egress_inactive`. `scripts/worker-smoke.mjs` already asserts it (`9ae393e3`, `96980f80`). Extend it to assert that **no row** in `hyperliquid_egress_sends` has the standby's `holder` before its lease.

### 3.4 Clocks

- Admission uses `performance.now()`.
- The log uses wall time. On seeding, `expires_at` is converted with the offset sampled once.
- `REST_CHARGE_LIFETIME_MS`'s 5 s slack covers skew between our clock, HL's and Postgres's.

---

## 4. 429 / AIMD and `foreign_usage_suspected`

On an HL rate refusal:
- **REST:** an HTTP 429 seen by `watchAnswer` (transport `:170-176`).
- **WS:** a WS `error` matching `isWsRateLimit` (`foreign-usage.ts`), via `noteWsError` (`:163`).

`egress.noteRateLimited(kind, retryAfter)` then does three things, and never throws:
1. **Block:** for that resource (`rest`, or `ws_message` and `ws_connect` together), `blockedUntil = now + (Retry-After header ?? 10 s)`. Only `live` may still be admitted during the block, and only for exchange POSTs (cancels and closes, so a 429 never strands a reduce-only close). Every other request waits. Its deadline applies.
2. **Decrease:** `capFactor = max(0.5, capFactor × 0.9)`.
3. **Foreign usage:** `use = sent units in the trailing 60 s ÷ nominal` (1200, or 2000 for WS). This counts only units actually dispatched; undrawn bundle holds are excluded. The counter is noted with `foreignUsage.note(egressKey, '429' | 'ws_rate_limit', use)`.
 - `restWindowUse` and `wsWindowUse` (`foreign-usage.ts`) become plain functions of `EgressStatus`.
 - The transport's `noteRateLimited` (`:156-161`) calls `quota.windowUse()` instead of `meterSnapshot()`.

Recovery: `+0.01` of nominal per minute with no refusal, up to 1.0. The factor and `blockedUntil` are in `status()` and the heartbeat.

Semantics on A: the scheduler counts *everything this process sends on this IP*, and this process is the only one of ours there. A 429 below 80 % therefore really is someone else (I-12, I-15). The I-17 condition 1 reporting (`rateLimited` and `count` daily) is unchanged. `ForeignUsageCounter.status()` is in the heartbeat.

`RequestBudgeterService.onRateLimited` (`request-budgeter.service.ts:999`) on worker-copy delegates to the egress through the pass-through budget, so one 429 is not handled twice.

---

## 5. Process scope

### 5.1 worker-copy (A)

Every `HyperliquidGlobalTransport` instance in the process gets a `MemoryHyperliquidQuota`-backed egress per egress key:
- The main one: `HyperliquidModule`'s `HYPERLIQUID_EGRESS_KEY`, used by mainnet and the watcher (`hyperliquid.module.ts`).
- The wallet one: `walletNetworkHyperliquid`'s `<key>:testnet` on a testnet deployment (`wallet-network-hyperliquid.ts:90-93`).

On mainnet both are the same key, so there is one egress.

The table in §2.1 lists the paths. None bypasses the transport: every socket goes through `reserveSocket`:
- `trade-feed.service.ts:214`
- `live-account-ws-source.ts:179`
- `trader-twap-reader.ts:127`, which is api only

### 5.2 api (C) and worker-read (B): recommendation

**Option R (recommended): retire the Postgres meter. Each runs its own memory egress.**

Classes on the api: `owner`, then `page`, then `background`. Floors: page 240, owner 60, background 60, active always (no live class). Classes on worker-read: `background` only, with the essential and analytics waits.

The case for it:
1. I-17 observed three distinct IPs:
 - worker-copy `208.77.246.108`
 - worker-read `208.77.246.60`
 - api `152.55.188.100`
2. Each is one process: the api has one replica (`docs/rate-limits.md`), and worker-read is lease-singleton.
3. A shared meter between two processes on *different* IPs only costs DB round trips and lock contention (the 2026-10-12 incident) and protects nothing.
4. It makes D11 (`shared_capacity`) deletable outright, and removes about 1,100 more lines in C13.

Required guards:
- The identity guard already alerts on any overlap (`egress_identity_shared`).
- New, in C13: on the api and worker-read, an overlap between those two halves each one's working cap (`HYPERLIQUID_EGRESS_CAP_SHARE=0.5` applied automatically while the alert holds). AIMD covers the minutes before detection.
- worker-copy keeps `enforce` as planned (I-17), so it never shares.

**Option K: keep the meter for B.** It applies only if Paul decides the api and worker-read must share an IP (Q2 open). Then keep the *plain* meter (no lane, no classes, `page:` and `bg:` only) for that key, as inventory §1.3 describes.

The deletion plan below works for both options. C13 is the only step that differs.

---

## 6. Deletion plan (D1–D12), file by file, and commit order

### 6.1 Preconditions, enforced in C9

Because the scheduler is per process, no other process may do setup or live work on A's key:
- `API_SETUP_DRIVE=worker` is required. `local` is refused at startup when `COPY_TRADING_MODE` is testnet or live. The flag is removed in C13.
- `API_TERMINAL_SETTLEMENT=off` is required on the api in a copy deployment.
- `WORKER_ROLE=all` remains valid: it is one process.

### 6.2 Commits

Each commit passes `pnpm -C apps/api test` and the real-Postgres shards (`450f41f4` records their run times). The whole series is **one merge**, which satisfies I-16's "same batch".

| # | Commit | Adds / changes | Deletes (D#) | Specs |
|---|---|---|---|---|
| C1 | `refactor(hyperliquid): HyperliquidQuotaBackend interface; the transport accepts any registered backend` | interface, brand `WeakSet`, `windowUse`/`status` on Postgres (from `meterSnapshot`) | — | `hyperliquid-global-transport.spec` (+ a forged backend is refused) |
| C2 | `feat(hyperliquid): HyperliquidEgress scheduler core (pure, injected clock)` | `hyperliquid/egress/{window.ts, sockets.ts, classes.ts, aimd.ts, scheduler.ts, status.ts}` | — | new: `egress-simulator.spec`, `egress-priority.spec`, `egress-preemption.spec`, `egress-floors.spec`, `egress-deadlines.spec`, `egress-sockets.spec`, `egress-aimd.spec` (§7) |
| C3 | `feat(hyperliquid): MemoryHyperliquidQuota (BoundHyperliquidQuota, HyperliquidSocketQuota), EgressScope, credit pool, egressBudget, pass-through budget` | `memory-hyperliquid-quota.ts`, `egress-budget.ts` | — | `memory-quota-permits.spec`: ports the non-SQL cases of `hyperliquid-global-quota-postgres.spec.ts:25-155` (one use, stale dispatch, ≤5 s fence, settle lowers only, sockets 10/1000/10, ack cleanup, peer EOF frees concurrent units only on proof) |
| C4 | `feat(hyperliquid): send log (0086), flusher, retention, seeding on lease takeover, clean stop` | migration, `egress-send-log.ts`, async provider factory, shutdown hook | — | `egress-send-log-postgres.spec` (seed from log, meter, both or none; crash 0.9; none 0.5); `worker-smoke` (standby writes no row, makes no call) |
| C5 | `feat(hyperliquid): HYPERLIQUID_EGRESS_BACKEND=memory\|postgres (default postgres); heartbeat egress status; 429 AIMD and foreign usage through windowUse` | `runtime-config.ts`; `hyperliquid.module.ts` and `walletNetworkHyperliquid` pick the backend; `egressBudget` vs `liveBudget` through one provider `HL_BUDGET_FACTORY`; shared contracts: heartbeat `egress` (additive) | — | `app-config.spec`, `hyperliquid-foreign-usage.spec` (both backends), `wallet-network-budget.spec` (both) |
| C6 | `refactor(copy): setup steps, live runtime and engine take capacity through StepCapacity (Postgres impl = today's withCapacity / claimLive / standby, moved verbatim; no behaviour change)` | `copy/live/step-capacity.ts` with `reserveStep({class,key,since,rest,connects,deadline}) → {run, release}` and `setLiveStandby`; `PostgresStepCapacity` holds the moved code | — | existing setup and live specs unchanged and green |
| C7 | `feat(copy): MemoryStepCapacity on HyperliquidEgress for worker-copy (memory backend)` | the impl; `copy.module.ts` and `copy-live-engine.provider.ts` choose by backend | — | gate replays (§7.3); memory variants of the real-PG reproductions (§7.4) |
| C8 | `test(copy-harness): synthetic contention inside the process for the memory backend` | `HL_EGRESS_SYNTHETIC_LOAD=loops:8,sockets:2` (refused at startup unless `COPY_TRADING_MODE=testnet` and `NODE_ENV≠production` and the egress key ends in `:testnet`); `contention.mjs --backend memory` prints the env line instead of writing meter rows | — | `harness.test.mjs` |
| *Stage soak* | worker-copy `memory`; api and worker-read `postgres`; the harness gate (§7.5) | | | |
| C9 | `refactor(copy)!: worker-copy schedules on HyperliquidEgress only; the setup and live claim flow is gone` | `PostgresStepCapacity` deleted; preconditions §6.1; ATTEMPT step demand = `{rest: ATTEMPT_STEP_REST_WEIGHT, connects: 2 × PREFLIGHT_SOCKETS}` (derived) | **D10**: `copy-live-setup-steps.ts:34-70,157-218` (`SetupRestCapacity`, `SETUP_LOCAL_BUDGET`, `SETUP_CLAIM_RENEW_MS`, `SETUP_CLAIM_LOG_EVERY_MS`, `withCapacity`, `withLocal`, `logClaimWait`, `setupHoldKey`); `copy-account-mode.service.ts:122-130,166-173` (`ATTEMPT_STEP_WEIGHT`, `ATTEMPT_SOCKET_CONNECTS`, `reserveForSetup`); `copy-agent.service.ts:142-149,231,288` (`reserveForSetup`, `takeReserved`); `copy-agent-exchange.client.ts:20-24,42-44`; `copy-funding-exchange.client.ts:46` (`takeReserved`); `copy.module.ts:117-120` (`SETUP_REST_CAPACITY`, `SETUP_LOCAL_BUDGET`). **D4 (caller part)**: `copy-live-engine.ts:50-53,92,180-189` (`standby`, `LIVE_STANDBY_RENEW_MS`), which becomes `setLiveStandby` each pass; `live-execution-runtime.ts:124-142,233,245` (`claimLive`, `runLive`) | delete or rewrite: `copy-setup-local-first`, `copy-setup-phase-claims`, `copy-setup-global-quota`, `copy-setup-capacity` (+`-test-utils`), `account-mode-prepaid-budget`, `copy-setup-admission-order` → `egress-priority` cases; `copy-live-setup`, `copy-live-setup-split` adjusted to the memory step capacity |
| C10 | `refactor(hyperliquid)!: the meter is a plain sliding window; lanes, claims, holds and markers are gone` | `planHyperliquidQuota` keeps `rest` (without `lane`, `heldMs`), `connect` (without `setupToken`, `live`), and the socket kinds. Unknown legacy ids (`setup:`, `live:`, `setup-demand:` …) still parse as plain charges, so an old api can share the row during the deploy | **D1** quota `:95-187,598-609` (`SETUP_HOLD_ID_PREFIX`, `setupHolds`, `drawHold`, `dropHolds`, `untouchedHolds`, `HYPERLIQUID_SETUP_GRANT_HOLD_MS`, `setup_release`); **D2** `:166-183` (`:g:r`, `revoke`, `revoked`); **D3** `:89-140,210-235` + transport `:79-99`; **D4** `:248-294,610-637` + transport `:18-20,106-137,148-149` + `postgres-hyperliquid-quota.ts:55-66,89-98,293-315`; **D5** `:236-247,512-533` + the shared part of `PAGE_CAPACITY_WAIT_MS`; **D6** `:120-133,488-490,641-649`; **D7** `:295-349` + `postgres-hyperliquid-quota.ts:144-160` + transport `:138-147` + `worker-heartbeat.service.ts:44`, `admin-system.service.ts:33` (heartbeat `setupDemand`/`liveDemand`/`pageLane` replaced by `egress`; openapi regenerated) | delete: `hyperliquid-setup-grant-hold`, `hyperliquid-setup-lane-quota`, `hyperliquid-setup-queue-quota`, `hyperliquid-live-lane-quota`, `hyperliquid-live-standby-quota`, `hyperliquid-meter-composition`, `meter-lane-heartbeat`; real-PG lane reproductions → memory variants (§7.4); `hyperliquid-global-quota.spec` trimmed |
| C11 | `refactor(hyperliquid)!: no real-money bucket specials; worker-copy has no local bucket` | `walletNetworkHyperliquid` returns the pass-through budget on memory; on postgres one budget | **D8** `hyperliquid-budget-wait.ts:94-120,158-284` (the `holdKey` options, `park`, `takeReserved`, `LOCAL_HOLD_*`, `reserveHeld`, `parkHold`, `dropHold`), `request-budgeter.service.ts:224-230` (`LIVE_YIELD_RANK`); **D9** `request-budgeter.service.ts` `liveFirst` (`:322,378,427,736-742,955-957`), `refundLive`'s reserve path; `wallet-network-hyperliquid.ts:27-31,41-51,68-72,78-94` (`LIVE_HEADROOM_SHARE`, `setupBudget`, `walletSetupBucket`); `hyperliquid-budget-wait.ts:286-293` (`assertBucketHolds`); `copy.module.ts:125`; `COPY_LIVE_WEIGHT_PER_MIN` and its 485 cap (`runtime-config.ts:220`; a deprecation WARN if still set); `assertLiveEvidenceCapacity` re-based (§2.2); `admin-system.service.ts:38`, `worker-heartbeat.service.ts:73` | delete: `setup-local-hold-budget`, `setup-bucket-heartbeat`; rewrite: `wallet-network-budget`; `live-order-budget.spec` drops `:65,:73,:80,:162`, keeps `:57,:92`, and rewrites `:146` against `cap − floors` |
| C12 | `refactor(copy)!: one budget reason; last_wait without bucket details` | `meterRetryMs`; `insights/cohort.service.ts:243` uses `sharedRestRetryAfterMs`/the code; `copy-account-mode-evidence.ts:190-193`, `copy-agent-exchange.client.ts:106`, `hyperliquid-agent-approval.ts:59`, `live-leverage-update.ts:139-140`, `privy-account-mode-client.ts:202` move to `meterRetryMs`; `copy-live-engine.ts:375-377` uses `retryMs` only | **D11** `hyperliquid-budget-wait.ts:6-14,64-76` (`shared_capacity`, `sharedCapacityWait`, `SHARED_CAPACITY_RETRY_MS`/`MIN_RETRY_MS`), `error-class.ts:2,56,179`; **D12** `db.ts:2063-2064` type, `BudgetWaitDetail` (`hyperliquid-budget-wait.ts:26-37`), `safe-error-text.ts:43` | `error-class`/`retry-policy` specs; `copy-live-setup` `last_wait` assertions |
| C13 (+1 week) | `refactor(hyperliquid)!: api and worker-read on memory; the Postgres meter retired` (option R) | the api and worker-read use memory; cap share on overlap | `postgres-hyperliquid-quota.ts`, `hyperliquid-global-quota.ts` planner, `HYPERLIQUID_EGRESS_BACKEND`, `contention.mjs` meter mode; tables dropped a week later (0087) | `hyperliquid-global-quota-postgres`, `hyperliquid-peer-eof-postgres`, `hyperliquid-ws-lease-index`, `hyperliquid-live-meter-contention` deleted |

**Acceptance check for I-16, run on C12.** `rg` over `apps packages scripts` must return nothing for:

```
setup-hold:|setup-demand:|live-demand:|live-standby:|:g:r|SETUP_GRANT_HOLD|SETUP_PENDING_HOLD|LIVE_DEMAND_HOLD|LIVE_STANDBY_HOLD|LIVE_DEMAND_RENEW|LIVE_STANDBY_RENEW|PAGE_HOLD_MS|PAGE_FLOOR|LIVE_WS_CONNECT_RESERVE|MAX_SETUP_CONNECTS|hyperliquidMeterComposition|hyperliquidLaneStatus|reserveHeld|parkHold|LOCAL_HOLD_|LIVE_YIELD_RANK|liveFirst|LIVE_HEADROOM_SHARE|assertBucketHolds|setupBudget|withCapacity|SETUP_CLAIM_|logClaimWait|reserveForSetup|takeReserved|ATTEMPT_STEP_WEIGHT|ATTEMPT_SOCKET_CONNECTS|shared_capacity|sharedCapacityWait|claimSetup|claimLive|standbyLive
```

Matches in docs are allowed.

**Kept (inventory §1.2):**
- the 5 s evidence clock and `assertFresh`;
- settlement claims, digests, reservations and the journal;
- the setup lease, `transition()` CAS and the abort saga;
- `classify` and `decideRetry`;
- the socket lease *semantics*, in memory on A;
- `info-weights.ts` and every `*_WEIGHT` derivation;
- the injection guards, deploy gates and the identity guard.

---

## 7. Test plan

### 7.1 Simulator property test (`egress-simulator.spec.ts`, C2)

- A seeded PRNG (mulberry32; no new dependency) and 10,000 seeds × 600 simulated seconds on a fake monotonic clock.
- Random arrivals over all classes:
- REST 1–800;
- message bursts up to 300;
- connects 0–6;
- sockets with 0–300 subscriptions and 0–3 users;
- bundle lifetimes and draw patterns, including partial use and release;
- 429 injections, preemptions, and deadlines from 0 to 30 s.
- **Invariants checked after every event:**
- no trailing 60 s window of *dispatched* units exceeds the nominal cap (1200 / 2000 / 30), and never the working cap × factor at the time of admission;
- connections ≤ 10, subscriptions ≤ 1000, users ≤ 10;
- connects never closer than 200 ms;
- `held` is never negative, and a release is exact (Σ reserved = Σ drawn + Σ released);
- a touched bundle is never revoked;
- every request ends admitted, timed out at its deadline (± one tick), or aborted by its signal;
- no live request waits while a lower class is admitted, except a backfill that leaves its whole demand free.
- On failure, print the seed and a minimal trace.

### 7.2 Behaviour specs (C2–C3)

- **Priority.**
- live > setup > owner > page > background with every head waiting.
- FIFO for setups is by `since`: a younger setup arriving first still goes second.
- Round-robin over userIds within `owner` and `background`.
- **Backfill.** A 20-unit background read is refused beside a waiting 635 setup when the window has 636 free, and admitted with 700 free.
- **Preemption.**
- An untouched setup bundle is revoked for a live head; the step's first draw throws `local_budget {preempted}`.
- A touched bundle is not revoked: the live head waits, and its estimate is right.
- Nothing is revoked when all untouched bundles together do not cover the shortfall.
- **Floors.**
- A setup under 240 that has waited more than 5 s goes before owner and page once, then waits again.
- Floors are disabled while any live request is queued or extending.
- Floors never take from `S`.
- An order of the standby's size is admitted at once after the floors are spent.
- **Deadlines.**
- Each class's default from §2.4.
- The in-clock overflow throws `HyperliquidRestCapacityError`.
- The setup ghost keeps the place for its next pass and expires after 30 s.
- **WS.**
- The 11th connection waits and is admitted on a close.
- Users: the 11th unique user waits; an 11-user demand is over capacity.
- A standing feed socket is never preempted.
- Connect pacing.
- Prepaid cleanup and close messages are counted as today.
- **429/AIMD.** Block, ×0.9, floor at 0.5, +1 %/min recovery, live exchange POSTs still allowed, `foreign_usage_suspected` exactly when dispatched use < 80 %.
- **Seeding.** Log only; meter only (markers skipped); both (no double count); crash (0.9); none (0.5 for 65 s).
- **Over capacity.** live > 1140, and setup > 1140 − S, both give `live_budget_over_capacity`.

### 7.3 Replay of the logged gate compositions (C7, `egress-gate-replay.spec.ts`)

The fixtures (`test/fixtures/egress-gate-replays.ts`) are taken from the commits since `3991a500` and the existing reproductions:

| Gate | Source | Replay asserts (memory, simulated time) |
|---|---|---|
| 4th, 08:18 | `09fce747`; `copy-setup-queue-postgres.spec.ts` `scenario('gate4')`: setup 613 never granted in 603 s, 30 waits, background granted 130 / refused 13,414 | the setup's 635 + 2 connects is admitted within one window (≤ 65 s) beside 8 background loops of 20; background is refused first; pages within 6 s |
| 5th, 09:48 | `7076006b`, `2eb3a32b`; `scenario('gate5')`: `local_budget` 613, tokens 498/433/459, queued 2; absence-proof sockets on the meter | no local wait exists after admission (one bundle per step); the attempt runs through; running in ≤ 3 min |
| 6th | no composition was logged in any commit or doc since `3991a500` | taken from the gate record if it has one; otherwise covered by 5 and 7 (stated in the spec) |
| 7th, 11:03–11:17 | `c8e8f7d7`, `e9acb532`, `copy-live-starvation-postgres.spec.ts:1-60`: background 760 of 1200 at 11:05; order 568 waited ~27 s; setup 715 + 81; leader source read 240; two socket loops filling 30 connects/min | the leader's source read is never refused; the order is admitted ≤ 1 s after its request (standby 568); its 6 connects are never refused (live head ahead of the socket loops); sent within `ORDER_SLA_MS` 10 s; 1200 holds |
| 8th, 12:51 | Privy identity expiry (agent and mode, `PRIVY_IDENTITY_EVIDENCE_CODES`) | the step's bundle is reserved *before* its identity proof starts aging, and no egress wait lies between the identity read and the POST |

Each replay runs twice:
- **"single IP, today's load"**: worker-read's background on A as well, the worst case;
- **"post-split"**: A carries only worker-copy's own load.

### 7.4 Real-Postgres reproductions

These rows reflect the plan in §6.2.

| Spec | Fate |
|---|---|
| `copy-setup-contention-postgres` (gate 1, 06:51) | real PG for the setup rows, leases and risk scope; memory egress; synthetic in-process contention; real time. Must reach running within its bound. Rewritten in C7, Postgres variant deleted in C10 |
| `copy-setup-queue-postgres` gate4 / gate5 | same treatment |
| `copy-live-starvation-postgres` (7th) | same treatment; the order SLA assertions unchanged |
| `hyperliquid-live-lane-postgres`, `hyperliquid-setup-lane-postgres` | merged into one memory reproduction: a cold live order beside a setup attempt; the order gets 589 in < 5 s and is never refused |
| `hyperliquid-live-meter-contention` | the Postgres variant stays until C13; a memory variant asserts **zero** quota SQL statements inside an original session |
| `hyperliquid-global-quota-postgres`, `hyperliquid-peer-eof-postgres`, `hyperliquid-ws-lease-index` | unchanged until C13 (the plain meter stays for the api and worker-read and for rollback); the planner cases they cover are trimmed in C10 |
| `copy-live-execution-runtime`, `copy-live-postgres`, `copy-live-risk-scope`, `copy-live-e2e` | must pass unchanged on both backends (parametrised with `describe.each(['postgres','memory'])` from C7 to C12) |

### 7.5 Gate acceptance (Phase 2)

1. All of §7.1–7.4 green. Simulator: 10,000 seeds.
2. The C12 `rg` check returns nothing (I-16).
3. The harness gate passes **3 consecutive runs** with `stage-like.env` and `HL_EGRESS_SYNTHETIC_LOAD=loops:8,sockets:2` on worker-copy:
 - setup p95 < 60 s;
 - order evidence wait p99 < 2 s;
 - 0 live orders failed for capacity;
 - 0 `account_mode_absence_unproven` from socket refusals.
4. A 24 h Stage soak with `memory` on worker-copy: 0 HL 429s on A; `foreignUsage.rateLimited` and `count` recorded daily (I-17 condition 1).
5. Two redeploys of worker-copy during the soak, each logging `egress_seeded {from:'log'}`; `worker-smoke` proves the standby wrote no send row and made no call.
6. The heartbeat and the admin overview show `egress` (classes, window, sockets, AIMD, standby, seed).

---

## 8. Rollout, mixed versions, rollback

**Flag:** `HYPERLIQUID_EGRESS_BACKEND=memory|postgres`.
- Read on every process. The default is `postgres` until C9, after which worker-copy requires `memory`.
- `memory` is refused on the api while `API_SETUP_DRIVE=local`.

**Order:**
1. Merge C1–C8; deploy with all `postgres` (a no-op).
2. Set worker-copy to `memory`. The first boot seeds from the meter row.
3. Soak (§7.5), run the gate.
4. Merge C9–C12 (the acceptance batch).
5. A week later, C13 (option R).

**Mixed versions:**
- Two copy workers never send at once (lease 1). The successor seeds from the log *and* the meter row, so the handover works old → new and new → old.
- From C4 on, the Postgres backend also *imports* recent `hyperliquid_egress_sends` rows into its row as `log:<id>` events on its first bind. A flag rollback therefore sees memory-era sends.
- During C10's deploy an old api may still write `setup-demand:` / `page:` events. The reduced planner reads them as plain charges and never rejects them.
- Heartbeat contract changes are additive in C5; the old fields are removed in C10, and the web reads `egress` when present.

**Rollback:**
- Before C9: set `HYPERLIQUID_EGRESS_BACKEND=postgres` on worker-copy and redeploy. The import of the log protects the first minute.
- After C9–C12: the primary rollback is Railway "redeploy previous" to the C8 release, whose Postgres backend imports the log.
- Setting `postgres` on a C12 build gives only the plain window (no classes). Use it as an emergency only.
- Older images (pre-C4) cannot read the log. They rely on `startupPaceSeconds` (50 % for 60 s, `request-budgeter.service.ts:184,384-390`): a small 429 risk in the first minute, which AIMD in those images still halves.
- C13 is reverted by setting the api and worker-read back to `postgres` while the tables exist. The tables are dropped only a week after C13.

---

## 9. Effort and risks

### 9.1 Effort (engineer-days)

| Commit | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 | C13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Days | 0.5 | 3 | 2 | 1.5 | 1.5 | 1.5 | 2 | 0.5 | 1.5 | 1.5 | 1 | 0.5 | 1 |

- **Total ≈ 18 days**, plus 1–2 days of Stage soak and gate time.
- §4 estimated 6–8 + 2–3 days. The difference is the per-commit green rule (C6's move-then-delete), about 10 spec rewrites, the replays and the log.

### 9.2 Risks

1. **The single-process assumption is broken.** Examples: `API_SETUP_DRIVE=local`, a second replica, or `WORKER_ROLE=all` beside `copy` on one key. The scheduler would undercount.
 - Mitigations: the C9 startup refusals; lease 1; the identity guard.
 - Residual: a misconfigured second service on the same key. Mitigation: the heartbeat shows `holder`, and the api alerts on two holders of one key in the send log within 2 min.
2. **Send-log loss on a crash** (≤ 250 ms / 64 rows). Mitigation: a crash takeover runs at a 0.9 factor for 65 s.
3. **The api and worker-read share an IP after a redeploy** (option R). Mitigation: the `egress_identity_shared` alert → automatic 0.5 cap share; AIMD.
4. **Foreign tenants on Railway egress** (I-15, I-17). The scheduler cannot see them. Mitigations: AIMD, `foreign_usage_suspected`, the region-move playbook. The HA gateway's 3 IPs are still capped as one IP (I-15 note 1).
5. **HL's WS rate-limit wording is unverified** (I-15 note 3). WS AIMD fires only on matched texts. Mitigation: calibrate from `hl_ws_error_unmatched` before mainnet.
6. **The setup driver blocks the engine pass** while it waits (bounded by `reserveWaitMs`). The ghost preserves fairness. Running setups off the pass is a follow-up.
7. **Floors at 300 instead of 360** (a deliberate change to §2.4's 30 %), so that the 793 startup bound fits. Three accounts plus the leader stays refused at startup, as today.
8. **Visibility moves from Postgres to the heartbeat.** Post-mortems rely on the send log (10 min) and the log lines. Consider raising retention to 24 h if the table stays small (~1 row per send; about 100k rows/day at today's load).
9. **The harness's contention moves in-process** (C8). The flag must never reach production. It is refused at startup outside testnet, non-production and a `:testnet` key, and is covered by `app-config.spec`.
10. **A large merge.** Mitigations: the C6 seam and the dual-backend parametrised specs C7–C12; each deletion commit removes its specs together with its code.
11. **The trade feed, now `standing`**, permanently holds about 2 connections and ~329 subscriptions on mainnet A (`trade-feed.service.ts:212`). That leaves ~670 subscriptions for evidence (538 for a two-account testnet order) and 8 connections. On testnet, order (538) + setup (269) = 807 > 670 if the feed runs on the testnet key. The feed is mainnet, so it is a separate key on Stage; on mainnet both share one key.
  - **[verify]:** subscriptions on mainnet A with the feed, two orders and a setup at once.
  - Mainnet's 11 dexes (I-1) make an order about 14 subscriptions, so the risk is testnet-only.

### Critical files for implementation
- apps/api/src/hyperliquid/postgres-hyperliquid-quota.ts (the `BoundHyperliquidQuota` / `HyperliquidSocketQuota` seam, `:29-68`, and the permit and socket semantics to port, `:171-438`)
- apps/api/src/hyperliquid/hyperliquid-global-transport.ts (the constructor check `:60-64`; the lanes and claims to delete `:79-149`; `noteRateLimited` `:156-161`)
- apps/api/src/hyperliquid/hyperliquid-global-quota.ts (D1–D7 `:44-349`; the planner reduced to a plain window `:420-677`)
- apps/api/src/copy/copy-live-setup-steps.ts and apps/api/src/copy/live/live-execution-runtime.ts (`withCapacity` `:157-218`; `claimLive`/prepay `:133-142,204-263`)
- apps/api/src/copy/live/error-class.ts (`BUDGET_CODES` `:54-67`, `classify` `:166-187`, `decideRetry` `:264-281`) with apps/api/src/hyperliquid/hyperliquid-budget-wait.ts and apps/api/src/hyperliquid/wallet-network-hyperliquid.ts
