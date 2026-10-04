# Signed Stop Cancellation Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task after the current release freeze. Steps use checkboxes. This planning assignment authorizes only this document; it does not authorize source changes, runtime registration, database operations, provider requests, signatures, or financial execution.

**Goal:** Let an enabled owner explicitly sign a testnet-only authorization to cancel the exact orders captured by their durable stop, then produce a durable, individually fenced cancellation attempt for each captured target.

**Architecture:** Keep the existing stop as an admission barrier. Add separate signed cancellation consent and a database-backed `TrackedCancellationAuthority`; keep existing trade/reduce grants unchanged. Reuse the original `LiveRiskDatabaseSession` for local reads/claims and existing one-attempt cancellation signer/transport for external work, with no SQL transaction spanning provider I/O.

**Tech Stack:** NestJS, Drizzle/PostgreSQL, Zod, viem EIP-712 verification, Privy SDK, installed `@nktkas/hyperliquid` 0.33.3, React/TanStack Query, Vitest.

**Spec:** The owner's instruction for the next slice is explicit signed wind-down consent binding exact stop/account/target digest/current setup-agent-grant-policy identities and versions/owner-master/nonce/deadline. The existing behavioral boundary is documented in `apps/api/src/copy/live/live-tracked-cancellation.ts` and `apps/api/src/copy/copy-live-stop.controller.ts`. This document specifies the cancellation subset; the continuing project objective remains all Copydog functionality.

## Global Constraints

- Current release sources are frozen. This document changes no executable files or release artifacts.
- Testnet only. No mainnet cancellation, automatic close, transfer, sweep, or account-mode change in this slice.
- `copy:reduce` and historical mandate consent never imply `copy:cancel`. Do not add cancellation to existing grants or broaden Privy policy.
- HTTP inputs identify server-owned resources; clients cannot supply a target manifest, agent identity, action, nonce, authorization snapshot, or claim token.
- Cancellation may run while new risk is paused and the strategy is stopping. Do not call a blanket can-trade gate, invent a leader fill, or construct an opening-risk reservation proof.
- A cancellation ACK proves submission acceptance only. It never releases reservations, removes follower positions, books fees, verifies flatness, or marks the stop stopped.
- Raw signatures, user JWTs and provider authorization material remain transient; persist bounded digests and verified evidence only.
- No live provider validation is implied by offline/mock or isolated PostgreSQL tests. Runtime activation and real testnet acceptance are a separate explicit release step.

## Review Focus

1. Owner/account/agent changes during signing must prevent the POST: Tasks 3, 5 and 6 pin original-context fencing.
2. A target filled or was cancelled while consent was being reviewed: Tasks 3–5 allow observation changes but never change captured target identity or infer financial settlement.
3. Browser timeout/reload or two tabs must recover the same consent/attempt: Tasks 2, 4 and 6 test durable uniqueness and no automatic resend.
4. SQL connection loss or worker succession after claim must not revive authority: Tasks 3–5 test original-session capability loss and conservative unknown recovery.
5. Provider policy retains the same ID while rules/owner/signers change: Tasks 3 and 5 compare actual policy fingerprint, ownership and worker quorum, not just IDs.

## Existing code to reuse and boundaries to preserve

| Existing implementation | Reuse | Caveat |
| --- | --- | --- |
| `copy-live-stop.repository.ts`: `request`, `assertStored`, target-manifest generation | Stop/account barrier, canonical target digest, bounded original execution/provenance validation | `originalConsentDigest` is old trading consent. Private `context` joins original mandate setup; it is historical evidence, not current signing authority. Extract pure manifest validation for reuse without changing barrier semantics. |
| `copy-live-mandate-consent.ts`: `verifyLiveCopyMandateConsent`; shared `liveCopyMandateOwnerTypedData` | Strict cloned input, distinct EIP-712 purpose, asynchronous signature verification | New domain and primary type are mandatory; do not accept a mandate signature as stop consent. |
| `CopyLiveMandateService.approve` | Verify outside transaction, then reload challenge and identities before activation | Its repository context requires paused trading preparation. Do not invoke it for stopping strategies. |
| `PostgresLiveRiskScope.run`, `assertOriginalLiveRiskSession` in `live/postgres-live-risk-scope.ts` | Original connection, policy/platform/user/account locks, five-second freshness, SQL-only `read`/`transaction` | No replacement pool connection or source-stream dependency. No asynchronous function masquerading as a synchronous final guard. |
| `loadLivePreparationAuthority` in `live/postgres-live-risk-authority.ts` | Exact owner/master/setup/wallet/grant joins as reference | Do not call directly: it demands active mandate/strategy, source coverage, no pending transfers, and new-risk conditions inappropriate for wind-down. |
| `PrivyUserWalletProvisioner.findOwned` | Read-only actual master wallet/user-filter/quorum verification | Use stored account external ID. Do not call `CopyWalletService.reconcile`, which mutates state and uses another DAL connection. |
| `PrivyUserAgentProvisioner.verifyWorkerQuorum`, `verifyPolicy`, `findOwned` in `live/privy-agent-provisioner.ts` | Actual worker quorum, exact policy rule fingerprint, agent ownership/additional signer checks | Do not call creation methods. `CopyAgentService.assertSetup` is only a reference: its reconciliation/global repository calls cannot run inside original-session authority. |
| `HyperliquidAgentApprovalVerifier.verify` | Uncached `extraAgents` evidence on exact trading account | Pass the real current underlying grant solely for exchange evidence. Its scopes do not grant cancellation. Reject missing/expired approval and unsupported network. |
| `copySignerNonces`, `PostgresLivePreparation.prepare` nonce upsert | Common `(network, signer_address)` allocation via `greatest(now, previous+1)` | Cancellation must share this allocator with order execution, not introduce a cancellation-specific counter. |
| `trackedCancellationAction`, `trackedCancellationFingerprint`, `assertTrackedCancellation`, `assertCancellationPermit` | Exact captured action and bounded permit validation | Cancellation authorization ID/version refer to the new consent authority, not historical order grant. |
| `PrivyTrackedCancellationSigner`, `HyperliquidTrackedCancellationTransport` | Fixed phantom hash, signature verification, before-sign/before-submit authority reads, quota dispatch guard | In-memory attempted set alone is insufficient; durable claim is required. |
| `apps/web/src/lib/copy-live.ts`: `approveLiveCopyConsent` | Owner snapshot, reviewed-intent equality, pre-send guard, non-retrying recovery flow | Keep separate stop-consent journal namespace and purpose; do not reuse trading activation state. |

Privy policy already restricts testnet phantom Agent schema/domain/time (`policyRules`); the cancellation action is hidden in `connectionId`. Preserve those rules. Application permit validation binds the action hash to one exact captured asset/cloid. The new consent is narrow application authority, not an assertion that Privy restricts the agent to cancellation.

## Data model and exact contract proposal

Use migration `packages/shared/drizzle/0054_signed_stop_cancellation.sql` if 0053 is still latest when execution begins; if another migration lands first, allocate the next unused number and update Drizzle metadata consistently. Never rename/rewrite the frozen 0053 migration.

### `copy_live_stop_authorizations`

Persist all immutable signed fields as columns plus canonical `intent jsonb` and `intent_digest text`:

- `id text PK`, `user_id integer FK users RESTRICT`, `stop_id text FK copy_live_stop_operations RESTRICT`, `account_id text FK copy_execution_accounts RESTRICT`, `strategy_id integer FK copy_strategies RESTRICT`, `idempotency_key text`.
- `network text = 'testnet'`, `purpose text = 'cancel_tracked_orders'`, `schema_version integer = 1`, `captured_stop_revision integer`, `target_digest text`.
- `account_address text`, `account_revision integer`, `account_wallet_id text`, `account_owner_quorum_id text`, `owner_privy_user_id text`, `owner_address text`.
- `setup_id text FK copy_agent_setups RESTRICT`, `setup_revision integer`, `execution_wallet_id text FK copy_execution_wallets RESTRICT`, `agent_wallet_id text`, `agent_address text`, `agent_owner_quorum_id text`, `worker_quorum_id text`.
- `grant_id text FK copy_wallet_authorizations RESTRICT`, `grant_version integer`, `grant_valid_from timestamptz`, `grant_expires_at timestamptz`, `policy_id text`, `policy_fingerprint text`.
- `nonce bigint`, `consent_expires_at timestamptz`, `expires_at timestamptz`; consent approval within five minutes, authority expires within thirty minutes of challenge and no later than grant/setup expiry. Require at least enough remaining validity to sign a request; no silent extension.
- `state text` in `prepared,active,revoked,expired`, `version integer default 1`, `consent_digest text NULL`, `verified_at timestamptz NULL`, `revoked_at timestamptz NULL`, `created_at`, `updated_at`.

Constraints: unique `(user_id,idempotency_key)`; unique `(user_id,nonce)`; partial unique `(stop_id)` where state is prepared/active; positive bounded versions/nonces (nonce <= 9007199254740991); lowercase nonzero address formats with owner/account/agent distinct; hashes exactly 64 lowercase hex; idempotency key existing 16–128 pattern; intent object <=16 KiB. Active requires consent digest and verification time within challenge approval window. Revoked requires revocation time. Expiry and timestamps must be ordered; canonical decoder compares EVERY mirrored field against parsed intent. Use immutable captured stop revision for signed identity, not a requirement that stop progress revision never advances. The target digest must remain unchanged throughout.

The distinct EIP-712 domain is `{name:'Copy Stop Cancellation',version:'1',chainId:421614,verifyingContract:zeroAddress}`; primary type `CopyStopCancellation`. Include every immutable field above except idempotency key and storage timestamps, mapped to uint64 for integers/millisecond times, address for addresses, and string for IDs/digests/purpose/network. The EIP-712 message ID is `authorizationId` corresponding to row `id`. No generic wind-down permission or close/sweep fields.

`policyFingerprint` means actual Privy policy rules/ownership/version fingerprint. Do not bind unrelated application opening-risk policy version: this slice sends no new position risk. Any future cancellation-specific policy must have its own explicit versioned contract.

### `copy_live_stop_cancellations`

- `id text PK`, `stop_id`, `authorization_id`, `user_id`, `strategy_id`, `account_id` with RESTRICT references; `authorization_version integer`.
- `network='testnet'`, `account_address`, `signer_address`, `target_execution_key FK copy_live_executions.key RESTRICT`, `target_fingerprint`, `target_immutable_digest`, `target_digest`, `asset integer`, `cloid text`.
- `claim_token text`, `claim_revision integer default 1`, `claimed_at timestamptz`, `state` in `claimed,accepted,unknown`, `nonce bigint`, `expires_after timestamptz`.
- `authorization_snapshot jsonb`, `owner_consent_digest`, `action jsonb`, `fingerprint`, `prepared_operation jsonb` (exact existing `PreparedTrackedCancellation`, <=64 KiB).
- `attempt_evidence jsonb NULL` (<=64 KiB), `observed_at timestamptz NULL`, `issue text NULL`, `created_at`, `updated_at`.

Constraints: unique `(stop_id,target_execution_key)` (one automatic attempt ever for this stop target); unique `(network,signer_address,nonce)`; unique claim token; positive claim/authorization versions; action type exactly cancelByCloid with one cancel; canonical application decoder validates all values including stored target action and immutable original evidence. `expires_after > nonce`, <= claimed time +60 seconds, <= consent authority expiry; nonce >= claimed time and <= claimed time +30 seconds. Accepted/unknown require bounded persisted evidence and observed timestamp. Claimed rows after crash are read-only recovery candidates, never reclaimed for signing. Do not store raw signatures or provider headers.

No DB constraint can enforce uniqueness across separate order/cancellation tables; the shared atomic nonce allocator is the cross-table invariant. Test actual contention against both paths.

### Routes under `/me/copy/live`

| Route | Input | Output / behavior |
| --- | --- | --- |
| `POST stops/:id/cancellation-authorizations` | strict `{idempotencyKey}` | Persist challenge, return `{authorization,intent}`; requires complete manifest and stopping barrier, no signing. |
| `GET stops/:id/cancellation-authorizations/by-key/:key` | route IDs only | Recover original challenge; never refresh nonce/deadline implicitly. |
| `GET cancellation-authorizations/:id/challenge` | ID only | Owner-scoped original challenge and current status. |
| `POST cancellation-authorizations/:id/approve` | strict `{consentSignature}` | Verify exact owner EIP-712 signature, reload binding, activate once. Duplicate identical approval returns original active record. |
| `POST cancellation-authorizations/:id/revoke` | strict `{}` | Atomically revoke/version increment under owner lock; barrier remains. |
| `GET stops/:id/cancellations` | stop ID only | Bounded owner-scoped attempt summaries; no claim tokens/full provider evidence/signatures. |

No public route accepts action/target/claim or directly sends a cancellation. The first network integration is an internal executor invoked by explicitly configured worker orchestration only after its separate readiness review. Routes return no-store, standard auth guards and ownership-safe 404; 409 safe codes distinguish stale binding, pending challenge, expired consent, tracking incomplete, duplicate payload conflict. DTO/OpenAPI/response schema and client contracts must agree. Keep current stop overview backward compatible; add cancellation capability/status fields explicitly when UI is wired.

## Task 1: Distinct consent contract and verifier

**Files:** create `packages/shared/src/copy-live-stop-consent-contracts.ts`, `apps/api/src/copy/copy-live-stop-consent.ts`, `apps/api/test/copy-live-stop-consent.spec.ts`; update shared contract exports.

**Interfaces:** `LiveStopCancellationIntent`, `liveStopCancellationIntentSchema`, `liveStopCancellationOwnerTypedData(intent)`, `verifyLiveStopCancellationConsent(intent,signature,now): Promise<boolean>`.

- [ ] Write tests using a local viem account that signs a valid intent, then change each identity/version/target/deadline field and assert verification fails. Test existing trading-mandate signature against new verifier, wrong owner, mainnet, future nonce, deadline equality, extra signature/token fields and mutation during async verification.
- [ ] Run `pnpm --filter @trading-dashboard/api test test/copy-live-stop-consent.spec.ts`; confirm missing implementation failures.
- [ ] Implement strict schemas and detached verification:

```ts
const parsed = liveStopCancellationIntentSchema.safeParse(structuredClone(intent));
if (!parsed.success || now < parsed.data.nonce || now >= parsed.data.consentExpiresAt) return false;
return verifyTypedData({ address: parsed.data.ownerAddress,
  ...liveStopCancellationOwnerTypedData(parsed.data), signature });
```

Validate signature syntax and catch verification failures as false. Canonical schema ordering drives digest encoding; never hash unconstrained client JSON.
- [ ] Rerun the focused test; commit the isolated contract slice after review.

## Task 2: Durable consent challenge, approval and owner-only routes

**Files:** shared `schema/db.ts`, new migration and metadata, new `copy-live-stop-consent.repository.ts`, `copy-live-stop-consent.service.ts`, `copy-live-stop-consent.controller.ts`, `dto/copy-live-stop-consent.dto.ts`; new API lifecycle/schema/routes specs; test database cleanup helper.

**Interfaces:** repository `prepare(session,stopId,key,now)`, `find(session,id)`, `activate(session,id,intentDigest,verifiedConsentDigest,now)`, `revoke(session,id,now)`; service owner-scoped prepare/approve/recover/revoke. These methods accept the original session; no hidden global DAL reads.

- [ ] Add isolated PG tests for unique keys, same-key/different-stop conflicts, malformed intent/column mismatch, incomplete tracking, owner swap, setup/grant change, approval timeout, replay after revocation and two concurrent approval requests. Assert all original grants remain byte-for-byte unchanged.
- [ ] Run the new selected specs on the dedicated test database only; verify they fail.
- [ ] Implement schema/decoder and routes. Prepare under user/account scope, capture one current active setup for this account (which may differ from the historical target signer), and sign that identity. Consent nonce is a separate local replay nonce; exchange nonce is allocated only at claim.
- [ ] Verify signature outside SQL transaction, then reacquire original operation scope and compare persisted challenge digest/current local identities. Commit active evidence only after a final deadline check. An expired challenge may be explicitly expired before creating a new keyed challenge; recovery must never do this implicitly.
- [ ] Verify ownership/auth/unknown-field rejection with Supertest and no provider/signing calls; rerun PG tests and commit.

## Task 3: Current cancellation authority on original session

**Files:** new `live/postgres-stop-cancellation-authority.ts`, `live/stop-cancellation-provider.ts`; new `test/copy-stop-cancellation-authority.spec.ts`; narrowly extract pure stop manifest validation if required.

**Interfaces:** `loadStopCancellationAuthority(session,binding,now)` where binding is `{stopId,authorizationId,operationId?}`; `StopCancellationProvider.verify(local): Promise<providerEvidence>`; `PostgresTrackedCancellationAuthority implements TrackedCancellationAuthority` bound to original session/worker epoch.

- [ ] Write PG tests that load genuine prepared journal/provenance from `preparationFixture` and `PostgresLivePreparation`, then request the actual stop. Test revoked older target grant with a separately valid current signer, forged target membership, owner disabled, wallet retired, setup version/policy mismatch, corrupt mirrored rows and changed master. Old target grant is historical; current signer grant is the validity dependency.
- [ ] Test stopping strategy plus paused platform succeeds for cancellation; missing leader stream, expired historical mandate and pending unrelated transfer do not invoke an opening-risk gate. Missing current consent/current grant still rejects.
- [ ] Implement local loader with original-session validation and SQL-only callback. Read stop/consent/current owner/master/setup/wallet/grant, target journal/provenance, and compare immutable target digest to the captured manifest. Mutable fill/order status may advance without changing immutable membership.
- [ ] Implement provider proof using read-only `findOwned`, exact policy/worker quorum and uncached exchange approval. Do not call create/reconcile. Preserve configured provider boundary/egress behavior and disable automatic retries. Collect earliest started observation time; reject evidence older than five seconds.
- [ ] Implement operation sequencing:

```ts
assertOriginalLiveRiskSession(session);
const before = await session.read(db => loadLocal(db, binding));
const proof = await provider.verify(before); // session locks held, SQL transaction closed
await session.scope.assertHeld();
const after = await session.read(db => loadLocal(db, binding));
assertSameCancellationBinding(before, after);
return makePermit(after, proof, () => {
  session.scope.assertFresh();
  originalWorkerGuard();
  assertConsentAndProviderFresh(after, proof, now());
});
```

`loadLocal`, `assertSameCancellationBinding`, `makePermit`, and `assertConsentAndProviderFresh` are private helpers in this new authority file; no replacement connection or source lock is introduced. Run provider reads concurrently only when independent, then validate every result and original scope.
- [ ] Test provider waits, policy same-ID edits, shutdown/worker replacement, session close and post-read owner/grant mutations; assert zero signatures/POSTs on failure. Commit when selected tests pass.

## Task 4: Atomic durable claim and common nonce

**Files:** new `live/postgres-stop-cancellation-journal.ts`, `test/copy-stop-cancellation-journal.spec.ts`; schema/migration cancellation table from above.

**Interfaces:** `claim(session,{stopId,authorizationId,targetExecutionKey},now): Promise<PreparedTrackedCancellation>`; `recordEvidence(session,operation,evidence)`; `readAttempts(session,stopId)`. A duplicate claim returns a recovery result from an orchestration wrapper, never another executable capability.

- [ ] Add PG concurrency tests for two processes claiming one target, different targets sharing one signer, and an order preparation competing with cancellation nonce allocation. Test rollback after nonce allocation before insert, nonce skew, target changed, expired consent, and restart with durable claimed row.
- [ ] In one session transaction reload current local authority and target; allocate nonce using the existing common table; build exact canonical target/action/fingerprint; insert claimed row and change stop to cancelling only after valid consent. Do not mutate original order/reservation or historical grant.

```sql
INSERT INTO copy_signer_nonces(network, signer_address, nonce)
VALUES ('testnet', $1, $2)
ON CONFLICT(network, signer_address)
DO UPDATE SET nonce = greatest($2, copy_signer_nonces.nonce + 1)
RETURNING nonce;
```

- [ ] Permit signing only for the caller that durably created this exact claim in the original live session. Existing rows, even fresh claimed rows, are observation-only to successors. Result persistence uses compare-and-set claim token/fingerprint/version; preserve ambiguity when a final DB write fails.
- [ ] Run selected tests and verify no nonce counter outside shared allocator; commit.

## Task 5: One-attempt integration without settlement inference

**Files:** new `live/stop-cancellation-executor.ts`, `test/copy-stop-cancellation-executor.spec.ts`; existing signer/transport only if interfaces require a narrow adaptation. No automatic runtime registration in this task.

**Interface:** `StopCancellationExecutor.attempt(session,binding)` composes claim, concrete authority, existing signer/transport and evidence persistence; returns durable status.

- [ ] Test crash before signing, ambiguous Privy response, quota delay after signing, expired final permission, POST timeout, malformed ACK, exact success and persistence failure. Use fake provider/exchange HTTP with real hash/signature checks and real PG journal.
- [ ] Wire original-session authority into existing signer/transport. Only the returned newly created claim may execute. Persist accepted/unknown bounded evidence; if the process dies, claimed remains ambiguous. Never auto-resubmit under a new operation ID after consent renewal.
- [ ] Assert successful ACK leaves original execution journal, held reservations, follower fills/positions/cash, flat certificate and stop completion untouched. A terminal target may be reported as no cancellation needed only from independent observation; that does not release its liability.
- [ ] Verify `sign` and `submit` permission phases each use current provider evidence and synchronous original session/worker guard. Test expiry during SDK authorization and signature verification, not only before method entry.
- [ ] Run all cancellation boundary plus new executor tests and commit. Runtime worker registration remains a subsequent release readiness decision, not an implicit consequence of this component existing.

## Task 6: Owner review/sign/recovery UI

**Files:** new `apps/web/src/lib/copy-live-stop-consent.ts`, `apps/web/src/components/copy/copy-live-stop-consent.tsx`, matching i18n and tests; integrate from existing `copy-live-stop.tsx`; preserve existing stop journal behavior.

**Interfaces:** `approveStopCancellationConsent(review,deps)` with owner snapshot/current binding/clock/read challenge/sign/approve-beforeSend dependencies; hook mutations set `retry:false`.

- [ ] Add tests for displayed target count/digest/account/testnet/current agent/expiry; no signer call before explicit approval; owner switch/logout after challenge or signature; reloaded changed intent; signature rejection; timeout then by-key recovery; two tabs and expired challenge requiring renewed explicit review.
- [ ] Show “Authorize cancellation of these tracked orders” with account and target count, expiry and exact scope. Explain that positions/funds remain until later close/settlement stages. Stop button continues immediately establishing local barrier without requiring wallet signature.
- [ ] Before sign refetch original challenge and compare reviewed immutable intent; after sign recheck owner/account/intent/deadline; use API `beforeSend` guard. Persist only attempt IDs/idempotency keys for recovery, never signatures. Recover active/pending challenge before offering another submit.
- [ ] Render accepted as cancellation request accepted, unknown as awaiting reconciliation, and signing unavailable when current setup/grant is invalid. Do not advertise positions closed or funds returned.
- [ ] Run selected web unit/UI tests plus API route contract tests; check mobile 390px and desktop 1440px fixture rendering. Commit after review.

## Task 7: Integration validation and release boundary

- [ ] Run typechecks and focused API/web tests once preceding slices pass. Use `pnpm --filter @trading-dashboard/api test test/copy-live-stop-consent.spec.ts test/copy-stop-cancellation-authority.spec.ts test/copy-stop-cancellation-journal.spec.ts test/copy-stop-cancellation-executor.spec.ts` plus newly created lifecycle/schema/routes specs and existing stop/cancellation regressions. Run web `pnpm --filter @trading-dashboard/web test test/copy-live-stop-consent.test.ts test/copy-live-stop-consent-ui.test.tsx`.
- [ ] Use a new local database ending `_test`, never DATABASE_URL or the parent's currently running regression DB. Follow `apps/api/README.md` migration setup and `getTestDb` safety checks. Update `truncateAll` for new RESTRICT-linked tables. Vitest file parallelism is disabled but two separate test processes can still truncate each other: never share the database across processes.
- [ ] Check migrations on empty and existing schema, repeated migration runner behavior, and restart recovery of active consent/claimed/unknown attempts. Use actual original-session PG capabilities; do not replace them with structurally compatible mocks.
- [ ] At the implementation release boundary, register owner consent routes/UI with explicit capability reporting. Register financial worker invocation only with its own reviewed runtime configuration and acceptance evidence. No mainnet switch. Do not run real cancellation as an incidental smoke test.
- [ ] Update inventory with exact delivered stages: barrier, signed consent, durable cancel request, observed cancellation. Record closing, late-fill/account reconciliation, flat certificate and sweep as remaining work. Full Copydog parity remains the overarching objective.

## Done and remaining

This slice is complete when owner-signed cancellation authority cannot escape its captured stop targets, stale authority blocks both signing and submission, and repeated/restarted workers cannot submit another attempt. Existing paper balances and actual reservation/fill ledgers remain unchanged by cancellation ACKs. Offline evidence is clearly separated from testnet acceptance.

Next independent slices are evidence-based target reconciliation; exact position-close consent and durable reduction execution; final account-wide flat/liability proof; and separately authorized sweep with confirmed funds return. None is granted by this cancellation intent or the existing stop barrier.

The immediate next implementation action after the frozen release is Task 1: add failing distinct-domain/target-substitution/expiry tests in `apps/api/test/copy-live-stop-consent.spec.ts`, then implement its strict shared typed-data contract and verifier. No runtime registration is needed for that first slice.
