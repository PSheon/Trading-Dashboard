# Cleanup findings: copy (outside copy/live) and the rest of the api (2026-10-15)

Branch `cleanup/copy-rest`, from `813a770c`. This was a behaviour-preserving cleanup, and none of the
items below is fixed. Each one needs an owner's decision.

## Suspected bugs (code)

1. **`src/copy/live-worker/watched-mainnet-source.ts:49`:** `sealed = rows.length >= 500`.
   - The window here is `WATCHED_WINDOW_ROWS = 400`, and the millisecond re-read uses `MILLISECOND_ROWS`.
   - 500 matches `FAST_SOURCE_WINDOW_ROWS` in fast-mainnet-source.ts, which this file does not import.
   - It looks like a copied literal. Check whether it should be `MILLISECOND_ROWS` or another constant.
2. **`src/retention/retention.repository.ts:151`:** the sent-alerts delete orders by `a.sent_at DESC NULLS LAST`, but every other statement deletes oldest first.
   - Under the batch limit, the newest expired alerts go first and the oldest can wait several runs.
3. **`src/copy/copy-live-caps.ts` `assertLiveSettings`:** non-ratio sizing is refused when `ratioOnly` is set, and non-fixed sizing when `fixedPerTradeUsd` is set.
   - A deployment with both set would refuse every setting. Check that the config validation excludes that combination.
4. **`src/wallet/withdrawal.service.ts:23`:** `LEDGER_PAGE = 500`, while the paging comment records that Hyperliquid returned 2000 ascending rows on mainnet (2026-10-05).
   - The failure is safe: it reads more pages and reaches `LEDGER_MAX_PAGES` sooner.
5. **`src/copy/live-worker/copy-live-worker.service.ts` `drain()`:** logs "Testnet copy pass failed" on every network, mainnet included.
   - The string was left alone because harness scripts parse log lines.
6. **`src/traders/trade-analytics.service.ts`:** the comments said the default rank is `PAGE_RANK.fills`, but the code default is `RANK = PAGE_RANK.analytics`. `compute()` also has an unused `_cold` parameter.
7. **`src/traders/traders-worker.module.ts:26`:** says only the worker refreshes watched traders' analytics, but `TradeAnalyticsService.current()` starts a refresh once the figures are older than `TRACKED_FALLBACK_MS`.
8. **`src/analytics/round-trip.service.ts`:** the `RoundTrip.side` doc says a flip's closing leg reports the side it came *from*, but a round trip opened by a flip takes the flip action's own side. Unverified.
9. **`src/copy/copy-live-setup-provisioning.ts:92`:** refreshes the nonce after `86_400_000` (1 day), while the comment says it is valid for two days. This may be an intentional margin.
10. **`src/copy/copy-funding.service.ts:40`:** the class doc and an error text say "testnet only" / "mainnet stays disabled", but the code only checks `copy.mode !== "disabled"`. The user-facing text may be stale now that mainnet is live.
11. **`src/discovery/discovery-pool.service.ts` `ledgerQueues`:** non-visible stale refreshes run before cold builds, inside the `POOL_LEDGER_REFRESH_SHARE` split. The docs say "visible stale, then builds, then the rest". Confirm which order is intended.

## Comments corrected to match the code (no code change)

- Stale "testnet" wording in the copy-live close/setup/mandate files, copy-account-closure.module, and copy-agent-exchange.client, which still described the browser-signed approval.
- Hard-coded durations replaced by constant names: watcher refresh/catch-up, the setup-abort settle retry, the abandoned-approval window, the settings TTL, and the Privy timeout.
- `cohort.service` `history()` serves the last BTC candles it read, not an empty list. Its failed-member cooldown was documented as 65 s; it is `COHORT_FAILURE_RETRY_MS` (5 min).
- `kol.service.ts:23-28` still says the pool picks up KOL changes "≤ 1 min". `POOL_REBUILD_MS` is 10 min, so this comment is left to fix.
- `copy-live-engine.ts` `signal()` returns `null`, not false. `copy-risk.ts` `evaluateRisk` always approves reductions.

## Kept on purpose

**Only tests call these, but they are load-bearing or models, so they stay:**
- `referral/referral-ledger.ts`: `calculateReferralEarning`, `requestReferralClaim`, `transitionReferralClaim`. The referral payout domain model is documented as disabled until treasury integrations exist; production uses only `claimIntentHash`.
- `analytics/fill-integrity.ts`: `auditFills`, `reconcileFills`. The archive audit oracles used by the archive and manual-reconcile tests.
- `analytics/fill-codec.ts`: `sameFill`, a test oracle. `watcher/action-store.ts`: `withActionLock`, a fixture for the outbox tests.
- Setup, abort, stop and closer safety code: `depositOnLedger`, `assertCloseWithinPosition`, `closeSlippageBps`, the stop/abort residual return, and unattempted recovery.
- Every other "test-only" export in the scan is still used inside its own file. These are pure helpers exported for tests.

**Egress inventory D1–D12:**
- Code and comments are untouched.
- `CopyLiveSetupService.capacity` and `setupBudget` are still flagged by `tsc --noUnusedLocals` and were left as they are.

**Not done:**
- More duplicate helpers exist: the `num`/`numOrNull` parsers, which differ slightly; `listWeight` in traders vs. copy/live-worker; and `round2`. They span domains, so they were not merged.
