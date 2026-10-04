# Next durable cancellation, stop, flat and sweep integration

Implementation plan within the user-authorized Copydog parity scope, following the 2026-10-04 verification/deployment checkpoint. This document does not claim these remaining capabilities are implemented. No runtime registration or financial operations were performed while preparing it.

## Existing usable boundaries and concrete gaps

The present actual pipeline supplies original user/account/source locking, one same-session provider epoch, current controls/policy rereads, exact IOC order journal/provenance/baseline, actual receipt settlement, generation projection, global egress permits and final SDK/fetch callbacks. Late receipt reconciliation deliberately works after disabled/stopped/revoked owners. Newly certified local expiry cleanup handles only genuinely never-submitted prepared+held orders.

The financial port is order-only: `LiveExecutionRecord.action`, `LiveExecutionGate`, `PrivyOrderSigner` and `HyperliquidLiveTransport` all bind `LiveOrderIntent`/`HyperliquidOrderAction`. `loadLivePreparationAuthority` requires strategy+mandate active, authenticates with `reduceOnly:false`, and assumes a real leader source fill. Therefore existing pure risk treatment of reduce-only controls does not yet admit concrete wind-down. Stop-close cannot be inserted as a fabricated source fill/leg. Current mandate pause/revoke endpoints are local admission barriers, not cancellation or refund.

`CopyFundingRepository` exclusively binds embedded-owner→dedicated-account deposits; `walletWithdrawals` exclusively concerns bridge withdrawals. Neither represents dedicated-master→embedded-owner sweep, named-DEX balance consolidation or an immutable account-flat certificate. Current worker policy signs only exact testnet phantom `Agent` typed data and expires with the owner policy; it neither grants user-signed transfers nor lets the worker own/remove policy. Its connectionId hides the underlying action, so per-action cancellation/reduction checks remain mandatory application boundaries.

## Ordered narrow slices

1. **Durable stop barrier and exact tracked cancellation.** Introduce an explicit owner stop operation, set strategy stopping/pauseNewRisk/reduceOnly under existing fences, and preserve immutable old-generation identity. Capture exact original tracked order targets. Add a separate cancellation journal and signer/transport/gate; do not widen the existing order-only executor to arbitrary action JSON. No reservation or source leg is released by cancellation ACK.
2. **Snapshot-backed stop-close origin.** Add a distinct immutable stop-position provenance, deterministic close identity, fresh all-venue original account frames and full current-generation receipt projection. Prepare one bounded reduce-only IOC per coin after pending cancels/unknown orders settle. Reuse order wire/risk/SDK/transport guards, but load a dedicated current wind-down authority rather than forging source fills or changing original mandates into active authority.
3. **Actual flat certificate.** After all attempted order liabilities have independently settled, persist a bounded reproducible certificate containing original full account/order/TWAP frames, immutable receipts/terminal proofs, scan coverage, local pending-transfer/reservation manifests and original identities/revisions. Only an atomic validated certificate can advance stopping→stopped. Owner-visible stopped-with-unswept-funds is an honest separate result.
4. **Explicit master sweep.** A distinct owner/master action signs a fixed amount/destination/nonce from the dedicated master, with its own durable transfer liability and exact fresh flat proof. No automatic signing or worker-agent transfer permission. Named-DEX collateral consolidation is a separately journaled owner action if necessary, not implicit funding/refund. Initially deny unsupported residual named-DEX/token funds with a visible blocker.

## Minimal schema additions

Parent owns shared schema/migrations/contracts. Suggested concrete tables:

**`copyLiveStopOperations`**: id PK; owner id/account id/strategy id/mandate id and original mandate admission revision; testnet/account address/original owner DID+owner address/master Privy wallet+owner quorum; captured original mandate/consent/settings digests; owner idempotency key; desired `cancel_and_close`; state `requested|cancelling|closing|blocked|flat|stopped`; revision; requestedAt/updatedAt; issue; flatCertificate JSON+digest nullable. Unique owner+key; partial unique account+nonterminal stop. CHECK all certificate/digest/timestamps paired and explicit state progression. Request immediately persists local barrier; any foreign manual balance/order, quarantine, scan gap or unresolved original outcome records blocker instead of claiming stopped.

**`copyLiveCancellationOperations`**: id PK/stopId FK/targetExecutionKey FK; exact original target fingerprint/account/cloid/coin/dex/asset and optional verified oid; actual signing grant/setup/wallet/revisions separately captured from the old target's historical signer; immutable action and fingerprint; unique per stop+target+target revision; signer-scoped nonce; expiresAfter; state `prepared|signing|unknown|acknowledged|verified|rejected`; claimedAt/claim token/attemptedAt; original intent/proof digests; bounded original ACK and target order-status evidence. Exact action `{type:'cancelByCloid',cancels:[{asset,cloid}]}` initially, without `fast` flag. Cancellation has no exchange-queryable cloid of its own: recovery queries the ORIGINAL target order, never invents a cancellation success lookup. A cancellation claim permits at most one SDK invocation and POST; signing/POST uncertainty never mints a successor nonce automatically.

**`copyLiveStopCloseProvenance`**: execution key PK FK to order journal; stopId FK; mandate id/original generation admission revision; stop revision and settings digest; coin; immutable original actual position signed quantity; all-venue snapshot digest/full bounded envelope; full generation-manifest digest/observations; reduction carry amount/revision; canonical intent+fingerprint; admittedAt/plannerVersion. Partial per-stop/coin unique unresolved attempt. Composite bindings make stop/strategy/account/generation equality explicit. This is a distinct origin from `copyLiveIntentProvenance`; the projector requires EXACTLY ONE origin and independently replays stop-close quantity/side/caps plus actual terminal receipt proofs. No fabricated leader time/tid/trade claim.

**`copyLiveSweepOperations`**: id PK/stopId/account id/owner id; exact dedicated source master wallet+quorum/address and embedded destination owner address/DID; network; source/destination DEX/token; canonical fixed amount/nonce/intent; original flat certificate digest/checkedAt; consent deadline and signed-consent digest; one-attempt claim metadata; state `prepared|signing|unknown|accepted|credited|rejected|cancelled`; immutable bounded transfer scan/receipt proof+digest/revision. Partial pending source-account unique, cross-table writer checks and signer-scoped nonce serialization. Accepted means ACK only; credited/complete requires actual immutable transfer receipt(s). Preserve minute/global charges and all unsettled liabilities.

The common signer nonce allocator must serve orders and cancels on `(network,signerAddress)` and enforce cross-table uniqueness under the original user scope. Transfer nonce namespace remains tied to the actual master signer. Do not use action-specific counters that collide with the same API wallet.

## Concrete service/port boundaries

```ts
interface RequestLiveStop { accountId: string; mandateId: string; idempotencyKey: string }
interface LiveWindDownRequest { userId: number; accountId: string; stopId: string }
interface LiveCancelTarget { executionKey: string; fingerprint: string; asset: number; cloid: string }
interface ScopedLiveWindDown {
  inspect(session: LiveRiskDatabaseSession, request: LiveWindDownRequest): Promise<LiveWindDownView>;
  prepareCancel(session: LiveRiskDatabaseSession, stopId: string, target: LiveCancelTarget): Promise<PreparedLiveCancel>;
  reconcileCancel(session: LiveRiskDatabaseSession, operationId: string): Promise<LiveCancelView>;
  prepareClose(session: LiveRiskDatabaseSession, stopId: string, coin: string): Promise<PreparedLiveStopClose>;
  certifyFlat(session: LiveRiskDatabaseSession, stopId: string): Promise<LiveFlatCertificate>;
}
interface LiveCancelGate {
  assertReady(input: { phase: 'sign'|'submit'; operation: PreparedLiveCancel }): Promise<LiveExecutionPermit>;
}
interface LiveMasterSweepClient {
  sign(intent: LiveSweepIntent, master: OwnedMaster, ownerJwt: string, assertFresh: () => void): Promise<Signature>;
  send(intent: LiveSweepIntent, signature: Signature, assertFresh: () => void): Promise<unknown>;
}
```

Public commands accept IDs and owner-reviewed intent only; producer-loaded original targets/sizes never come from HTTP scalars. GET by id/key recovers original operations without creating a key, nonce, signature or successor. Owner JWT belongs only to the explicit master sweep invocation and is never durable. New endpoint names can follow `/me/copy/live/accounts/:accountId/stops`, `/.../stops/:id`, `/.../stops/by-key/:key`, `/.../stops/:id/sweeps/challenge` and explicit approve; registration belongs to parent.

## Locks, current permission and unknown recovery

Hold existing policy7403 shared→platform7405 shared→user7404 exclusive→account hash7 exclusive→captured original source hash8 shared for the entire admitted factory invocation; all short SQL row locks occur afterward. No transaction spans HTTP. Stop/source ingestion must not acquire user/account locks after the source lock. One original session/epoch/global context supplies all reads; no pooled DAL self-deadlock, second connection, detached cache or successor lock capability.

Request stop is an owner-authorized local barrier even when old grant/mandate expires; it confers no signing permission. NEW financial cancellation/close requires enabled current owner, stable master ownership, fresh current setup/grant/Privy policy and uncached actual exchange approval; read-only late reconciliation and immutable receipt booking continue after revocation/disable. Introduce explicit `copy:cancel` local grant scope plus exact signed wind-down consent, or retain cancel as a separately owner-approved operation until that scope exists. Do not reinterpret `copy:reduce` as unrestricted cancellation of protective/manual orders. Grant renewal for stopping accounts needs a distinct explicit reduce/cancel-only owner flow; it must never re-enable opening risk or reuse an old pruned agent address.

A reduction authority loader may admit strategy stopping or paused while requiring an explicit stop operation and matching signed wind-down authorization. It must not relax the active source-admission loader globally. Source continuity gaps must block new-risk copying; they do not themselves prove that owned existing positions cannot be reduced. Reduction proof still requires independently validated historical source origins/receipts and exact fresh all-account position equality. Manual/prior-generation positions and unsupported collateral remain explicit blockers unless a separately signed whole-account cleanup permission is later implemented.

Cancelled orders can fill during cancellation. Reconcile target terminal status and every actual receipt, then use the existing full settlement proof to release its reservation and advance original source state/carry. ACK/error/not-found/timeout/expired signature and native transport EOF never prove order liability release. Unknown cancel remains query-only; unresolved original submitting/unknown/resting liabilities prevent flat/sweep. A new cancellation attempt, if needed, is an explicit new durable owner operation with a current target observation, never silent retry.

Stop-close sizing binds verified generation quantity and outstanding pending reductions, uses the fresh exact market/quote, retained requested price/size/nonce and fixed reduceOnly. Partial terminal reductions produce a new remaining-position round only AFTER immutable previous receipts settle; no in-flight resizing or reprice. Current margin/fees/slippage and original grant/policy permission recheck at actual SDK RPC and POST, including global dispatch expiry. Full flat requires complete all-venue orders AND positions, active TWAP absence, fresh provider frame at/after all relevant receipts, complete bounded scans and no pending reservation/transfer/manual/quarantine/gap. Close ACK alone is insufficient.

Flat proof has a checked moment, not perpetual validity. Sweep re-observes all frames and rereads authority/liabilities under original scope; it references the old immutable flat certificate but uses a fresh synchronous final fence. Funding, withdrawal, sweep, stop admission and owner/account writers share user7404 before rows. Signing or send ambiguity retains the transfer liability; local TTL cannot reclaim a potentially usable user-signed transfer signature.

## Official protocol constraints

Hyperliquid documents cancellation by asset+oid or asset+cloid, a separate TWAP cancel, and optional action expiry. Schedule-cancel is delayed, trigger-limited and not a substitute for current account terminal evidence. Transfer actions such as Core USDC send do not support expiresAfter; stop/sweep must keep their uncertainty journals. [Official exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)

The official SDK models market-close as an aggressive reduce-only IOC against the actual account position, and signs cancel actions with L1 signing while usdSend uses human-readable user signing. Accordingly worker phantom signing cannot be reused as a master sweep path. [Official Python SDK exchange implementation](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/exchange.py)

Nonces are per signer, not per strategy/account; API wallet deregistration/expiry may prune nonce history and old addresses should not be reused. Account queries use the master address. These facts require the common nonce allocator and separate historical-target/current-cancel-signer bindings. [Official nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)

Reduce-only cannot open an opposite position; IOC unfilled quantity cancels. Residuals therefore require fresh settled-position rounds rather than an assumed full market fill. [Official order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types)

## Verification and rollout gate

First slice can be implemented entirely offline with disposable PostgreSQL maxpool1 and installed SDK HTTP mocks: held stop versus owner edits/revoke; exact tracked target/cross-owner/manual target refusal; final callback clock+5001 or lost original session; durable-before-SDK claim; ACK ambiguity, duplicate invoke/crash/restart; target fills during cancel; no release on success ACK/error/not-found; original nonce allocator collision across order/cancel. Stop-close adds zero/fractional/partial/flip/late-fill/dust, full projector/carry certificate replay and CAS rollback. Flat adds inactive named venues, TWAP, manual positions/orders, unsupported collateral, scan gaps and unknown liabilities. Sweep adds explicit original owner/master consent, no worker signing, cross-target/payload mutation, stale flat/transfer fence, SDK hidden await, lost JWT, dropped reply and original receipt replay.

No financial worker should be registered until concrete current permission, durable transitions, real all-venue latency within five seconds and explicitly owner-approved testnet acceptance are proven. The next implementation should start with slice1 rather than claim cancellation+flat+sweep complete from a local stopping flag.
