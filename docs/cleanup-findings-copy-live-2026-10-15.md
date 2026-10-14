# Cleanup findings: apps/api/src/copy/live (2026-10-15)

Behaviour-preserving cleanup on branch `cleanup/copy-live` (base 813a770c).

## Suspected bugs

None found in the order path while doing this cleanup.

## Stale docs (not rewritten)

- `apps/api/src/copy/live/README.md`, opening sections and "Final execution
  checks and remaining integration": they still say the Privy adapter allows
  testnet only and that "no live/testnet execution mode has been enabled",
  and they list prerequisites that have since been built. Rewriting these
  needs someone who knows the current mainnet state. Only the two sections
  describing browser signing (removed in 6ba83d01) were deleted.

## Kept on purpose

- `CopyFollowerLedger.db` (injected and never read): its production
  constructor caller is `live-worker/copy-live-api-settlement.provider.ts`
  (outside this area), and there are 13 positional test call sites. Removing
  it needs a coordinated change with the live-worker owner.
- Test-only exports that are cache test hooks or pure oracles over production
  helpers: `resetLiveReadCaches`, `clearLiveSettlementProofCache`,
  `liveSettlementProofCacheStats` (module cache isolation between tests),
  `liveEvidenceWarmWeight` (test oracle built on `liveInfoWeights` and
  `LiveReadCache.cacheable`). The other "test-only" names in the scan are used
  inside production code and are exported only for tests.
- `LIVE_REQUEST_NEVER_BEGAN` / unsent release, unattempted recovery, and the
  settlement never-placed paths: load-bearing recovery paths, untouched.
- `error-class.ts`: `sharedCapacityWait` and the `shared_capacity` wait (D11
  in docs/egress-subtraction-inventory-2026-10-15.md) are untouched.
- `TrackedCancellationAction`, `LiveSettlementProof`,
  `NormalizedLiveSourceFill` stay exported: declaration emit needs them.
