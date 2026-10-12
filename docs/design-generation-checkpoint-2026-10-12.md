# Design: settled-history checkpoint for the live copy generation proof (2026-10-12)

Status: **proposal** (not implemented). Follows d8505e93 ("sizing envelopes keep settled proofs by digest"), which cut growth from ~115 KB to ~12 KB per settled order but left it linear. Paths are under `apps/api/src/copy/live/` unless noted.

## 1. Why it is still linear

- **The producer reads everything.** `postgres-live-generation-manifest.ts:40-54` loads every journal of the account (with provenance, leg, fill, reservation and evidence), plus every receipt, ledger row, carry row and manual close. The 2 MiB bound (`:92`) applies to the compact form.
- **Every envelope stores the whole manifest.** Preparation writes `compactLiveGenerationManifest(withCarry)` into each order's envelope (`postgres-live-preparation.ts:226`). That is about 12 KB per settled journal. The planner refuses anything over 2 MiB (`copy-live-source-planner.ts:97`), so the cap is hit after roughly 150–200 orders.
- **Every settled journal's proof is re-verified on every use.** The projection decodes each one (`copy-live-generation-projection.ts:206-209`), and `decodeLiveSettlementProof` re-runs `assessLiveReservationSettlement` over a full account snapshot (`live-settlement-proof.ts:37`).
- **Preparation multiplies that cost.** It projects 4 times (`postgres-live-preparation.ts:197`, plus the planner at `:230`, `:252` and `:289`) and loads the manifest twice (`:142`, `:248`). That is about 40 ms per settled order, so the 5 s window is exceeded somewhere past ~100 orders.
- **Every replay re-projects that order's manifest.** This applies to settlement `sourcePlan`/`replaySettlement` (`postgres-live-settlement.ts:247,298`), unattempted recovery (`postgres-live-unattempted-recovery.ts:65`), the risk gate (`postgres-live-risk-source.ts:100`), follower adjustment (`apps/api/src/copy/copy-follower-adjustment.ts:268`), and the manifest loader's unattempted replay (`postgres-live-generation-manifest.ts:65-86`).

**Goal:** an order's envelope holds a fixed-size reference to a checkpoint plus a short tail (normally 0–2 journals).

## 2. What a checkpoint is

A checkpoint is an immutable, content-addressed fold of a prefix of the generation. It is produced by the same per-entry checks the projection runs today. It grants no trading authority.

### 2.1 Tables (migration, additive only)

- **`copy_live_generation_checkpoints`**
  - Columns: `mandate_id`, `seq`, `account_id`, `digest` (unique, 64 hex), `prev_digest`, `folded_at` (the cut time T), `body jsonb` (size CHECK, e.g. ≤ 512 KiB), `created_at`.
  - Primary key `(mandate_id, seq)`. Rows are insert-only, and a new row must extend the previous one (`seq` and `prev_digest`).
- **`copy_live_generation_folded_journals`**: primary key `key` (FK to `copy_live_executions.key`), plus `mandate_id` and `seq`.
- **`copy_live_generation_folded_receipts`**: primary key `receipt_key` (FK to `copy_follower_receipts.key`), plus `mandate_id` and `seq`.

The primary keys on the two membership tables guarantee at the database level that a journal or receipt is folded at most once.

### 2.2 What the body commits to

The digest is `liveSourceDigest(body)`.

| Field | Replaces |
|---|---|
| `identity` (mandate, account, user, strategy, network, address, authorization, settingsDigest, leader, direction, maxMandateRevision) | the per-journal identity checks (`projection.ts:145-158, 173-174`) |
| `baselineDigest`, `firstFound` | `projection.ts:127, 168, 226` |
| `seq`, `prevDigest`, `foldedAt` (T), `checkedAt` | the chain link and cut time |
| `positions`, `positionsDigest` | the fill fold, including the reduce-only intermediate checks (`projection.ts:229-243`) |
| `receiptChainDigest`, `maxReceiptProviderTime` | `receiptManifestDigest` over the full lists, and the coverage checks (`projection.ts:227-228, 247`) |
| `coins` | the carry-missing check (`postgres-live-preparation.ts:188`) |
| `carryFloor[coin]` | "carry is never rewound" (`live-unattempted-release.ts:86-87`) |
| `settledLegs[legId]` (flip closes only, pruned after the max signal age of 86 400 s) | the flip-dependency lookups (`copy-live-source-planner.ts:215-221`) |
| `counts` | lifetime observability |

These are **not folded** and are read fresh every time, as today: `accountState` (quarantine), `conflicts`, `scan`, and the `carry` rows.

### 2.3 The consistent cut at T

A cut at T is valid only if all of these hold:

- Every journal with `createdAt ≤ T` is terminal by the projection's own rules: settled, `NEVER_PLACED`, `UNHELD_REJECTED`, an unattempted release, or a manual close whose `expiresAfter + grace + 60 s` is no later than `scan.through`.
- No journal or reservation is in flight.
- Every fill receipt with `providerTime ≤ T` is certified by a journal inside the cut.
- The account is not quarantined, there are no conflicts, `scan.issue` is null, and `scan.through ≥ T`.

## 3. Projection v2

1. **Factor out `foldEntries(state, …)`.** It is the existing journal loop and receipt loop, applied to an explicit state. The full v1 path is `foldEntries(emptyState(baseline), everything)`, which keeps v1 behaviour byte-identical.
2. **Manifest v2.** `checkpoint: {seq, digest, foldedAt} | null`. The `journals`, `receipts`, `ledger` and `manualCloses` lists hold only the tail.
3. **Checkpoint bodies are passed in by digest.** This mirrors `settlementProofs`. `decodeLiveGenerationCheckpoint` checks the structure, the digest, the identity, the baseline, `positionsDigest`, and `checkedAt`.
4. **Tail checks**, which are the main defence against double counting and missing fills:
   - every tail journal has `createdAt > T`, and a folded journal that reappears in the tail is refused;
   - every tail fill receipt has `providerTime > T` and is certified by a tail journal;
   - funding receipts may be older than T, because funding does not move positions;
   - carry rows are at or above `carryFloor`.
5. **Pinning.** The loader takes `form: 'full' | {seq, digest} | 'latest'`.
   - Preparation uses `latest`.
   - The risk gate uses the form the envelope names, and refuses if a newer checkpoint exists. That cannot happen while the order's own journal is non-terminal.
6. **Old envelopes** (v1, inline or digest form) keep the unchanged v1 path. Only replays of orders admitted before rollout stay linear.

**Result:** about 195 KB per envelope plus the tail. Preparation cost scales with the tail size, not with history.

## 4. Writer and locks

- `PostgresLiveGenerationCheckpointer.fold(session)` is SQL only, in one transaction. It loads the latest checkpoint, loads the delta, finds the latest valid cut, folds, and inserts the checkpoint and membership rows. A unique violation means another writer won, so it backs off.
- It runs only on the original `LiveRiskDatabaseSession`, which holds the 7404 user lock and the account lock. Receipt booking, preparation and settlement take the same lock (`copy-user-lock.ts:15`, `copy-follower-ledger.ts:169`), so nothing can change during a fold. Every await asserts that the lock is still held.
- **Triggers**
  - After settlement release, `releaseNeverPlaced` or `replaySettlement` (`copy-live-settler.ts:90,129,137`): the fold runs in a separate transaction on the same held session, so a fold failure never blocks a release.
  - After an unattempted release (`live-execution-runtime.ts:250`).
  - A background compactor for busy accounts, manual closes that only become foldable once the scan passes them, and backfill. It folds at most about 25 journals per run.

## 5. Safety properties

| Property | With checkpoints |
|---|---|
| Double count | Folded-table primary keys; tail entries must be after T; keys are unique within the tail |
| Missing fill | **Unchanged.** Every use still compares checkpoint plus tail with a fresh snapshot, so a wrong checkpoint cannot hide a position difference |
| Late fill on a folded order | A fill attributed to any folded key quarantines (`live_generation_folded_late_fill`). This newly covers manual closes, which needs product sign-off |
| Quarantine, conflicts, liquidation | Unchanged; read fresh. An uncertified or liquidation fill can never be folded |
| Unattempted release, carry, manual closes, flip | Checked at fold time, plus `carryFloor`, plus `settledLegs` |

## 6. Rollout (old and new processes overlap)

1. **Migration.** Tables only. Old code ignores them.
2. **Release A, readers first.** Ships every v2 decoder, the checkpointer and the late-fill rule, with `COPY_LIVE_GENERATION_CHECKPOINTS=write`. Checkpoints are written, envelopes stay v1, and a shadow comparison of v1 against v2 is logged.
3. **Release B (`=read`)**, only after every process runs Release A. Envelopes become v2. A straggling old process refuses them, so it fails closed.
4. **Backfill** through the compactor.
5. **Rollback** means setting the flag back to `write` or off. Never roll back to a build without the v2 readers while v2 orders are unsettled.

## 7. Tests

- **Equivalence and property tests.** v1 and v2 must give the same result at every valid cut and under every mutation: drop or duplicate a receipt, re-add a folded journal, an uncertified fill, a reduce-only violation, quarantine, a conflict, an unattempted release that has a receipt, rewound carry, a tampered checkpoint.
- **Concurrency.** Two folds racing produce exactly one row. A fold blocks receipt booking. A crash leaves no rows.
- **Late fill on a folded manual close.** It must quarantine.
- **Flip across a checkpoint.**
- **Old code and old envelopes.**
  - v1 inline and v1 digest envelopes still settle and pass the gate.
  - An old decoder refuses a v2 envelope.
  - The gate refuses an envelope pinned to a stale checkpoint.
  - Regression guard: envelope bytes at order 300 minus order 20 is under 16 KB, and proof decodes per preparation are at most the tail size.
- **300-order e2e.** 300 venues, alternating opens and closes. Envelopes stay at or below about 250 KB, preparation marks stay flat, and an offline chain audit equals the snapshot. Run it in the nightly or slow suite.

## 8. Risks and open questions

1. **Trust shifts from "re-prove everything each time" to "proven once at fold time".** This is the same model the baseline row already uses. A forged checkpoint row is caught by the snapshot equality check when positions differ, or by a chain audit job. An HMAC signature is optional (open question).
2. **Refactor risk** in the dense projection. The equivalence tests and the shadow phase mitigate it.
3. **Accounts that are never quiescent** stay linear. Measure this on Stage.
4. **The manual-close late-fill quarantine** needs product sign-off.
5. **Old funding receipts in the tail** rely on funding never moving positions.
6. **`settledLegs` pruning** is tied to `maxSignalAgeSeconds ≤ 86400`. Share the constant.
7. **Lifetime caps.** Decide whether they apply to the tail only or also to the cumulative counts. The folded tables need anti-join indexes.
8. **The baseline is still inline** (a large part of the 195 KB). Storing it by digest is a follow-up.
9. **v1 orders in flight at rollout** still replay linearly, once.
10. **Naming.** Avoid clashing with `generationManifest` in `copy-live-stop.repository.ts:150`.

## 9. Review revisions (2026-10-12, reviewer, tracker H-O1)

Adopted. Where these differ from §2–§8, they override them.

1. **Time domain.**
   - T lives in **provider time**: T = the providerTime of the last folded receipt, and T ≤ `scan.through − 60 s`.
   - A journal belongs to the cut by its receipts' providerTime, not by `createdAt`. This removes the dependency on O9 clock skew between the DB and Hyperliquid.
2. **The cut is per prefix, not per account.**
   - Only journals and reservations that belong to ≤ T must be terminal. Journals after T may be in flight, since they are in the tail.
   - This replaces "no journal or reservation is in flight" in §2.3 and removes §8.3.
3. **Explicit invalidators.** Any ≤ T receipt that is `follower_unattributed_trade` or a liquidation makes the cut invalid. Stating it in §5 only is not enough.
4. **Reverse assertion in the tail loader.** An anti-join must find no journal or receipt at ≤ T that is missing from the folded tables. This catches rows inserted late with older times, and incomplete backfill.
5. **Pinning rule** (refines §3.5). The gate refuses only when a newer checkpoint has T ≥ the order's own first receipt time (or admission time). A newer checkpoint whose T is earlier than the order is allowed.
6. **The baseline by digest ships in the same release** (moved out of §8.8). Otherwise the ≤ 250 KB target in the 300-order e2e is mostly used up by the baseline.
7. **The chain audit runs inside the E6 stuck-detector loop** (§8.1).
8. **Product sign-off (§5 / §8.4) is bundled with an admin un-quarantine endpoint, with audit, in the same release.** No admin path exists today (architecture review §D), and the new rule makes quarantine more likely.

**Gate:** implementation starts only after Paul signs off on item 8.
