# Optimization execution ledger

Plan/spec: `docs/copydog-gap-and-practices-review.md`; authorized order: data credibility → API/streams → scale/operations → paper-copy/execution preparation.
Baseline: 7904d39; isolated branch codex/audit-fixes. No remote deployment, real trades, production migration or external notification is authorized by this implementation run.

## Pre-flight and rulings

- Shared interfaces: API DTO → wire schemas → fixtures → web consumers must evolve together. New crowd comparison fields are optional for rolling compatibility; crowd valuation fields now allow null, so deploy the updated web consumer before the API; old clients must not receive a prior total that encourages comparisons between different cohorts.
- Ruling: Claude branch f25b29f already implements trade analytics/history/fees in the backend. Do not duplicate that unmerged backend work. Address E01 with the explicitly allowed 30-day label solution, label existing E02 gross metrics honestly, and advance independent E05 while awaiting/reviewing integration. Cost: period-selectable win rate and net/funding accounting remain pending until the new contract is integrated.
- Ruling: exposure change means marked notional difference for addresses observed at both dates, not trade flow; disclose matched/current/prior counts. Missing snapshots are unknown, not flat. Cost: partial coverage comparisons describe only the matched subset.

## Tasks

- E01: six UI rendering regressions observed RED; explicit 30d label, recorded perp round-trip source, missing-analytics state and fee/funding/history qualification now GREEN (6/6). E02 gross-label clarification only; no claim of net accounting.
- E05: matching cohorts, coin union, explicit exposure change and coverage UI completed. Review regressions additionally require null valuation/bias for missing entry or unrealized PnL, preserving position counts. DB tests and SSR rendering passed.
- E04: versioned flow-neutral method, excluded interval counts/fraction, capital floor and observed/partial/unavailable quality exposed; bilingual public methodology page added. No assertion of full history coverage.
- E06: HTTP Info runtime schemas and bounded decoded response reader implemented; malformed values, unsafe integers, unknown account modes and invalid nested referral data are rejected. WS paths remain outside this batch.
- E02/E03/E22: gross label/source clarification only; net accounting, history completeness and low-sample basis remain pending Claude integration.
- E07–E09: completed in the second batch below. E16 real-provider/proxy verification remains pending.
- E10: implemented in the third batch below. E11–E15/E17–E21: pending; external verification requires the actual configured environment.
- G01–G12: pending; real financial side effects require explicit separate authorization.

## Review and upstream compatibility

The required fresh branch review identified missing-PnL valuation, unknown totals rendered as zero, and official/live shape differences. Valuation findings were reproduced RED then fixed; missing amounts/bias now return null and UI renders a dash. Nullable crowd values require the updated frontend to deploy first; existing numeric-only clients need updating.

Official [spot context example](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot) omits `coin`, while a fresh public read on 2026-09-29 returned 885 contexts with zero missing identities, matching the pre-existing captured fixture. Contexts cannot safely be mapped by array index (existing live fixture is not aligned), so missing identity deliberately fails closed instead of guessing a token price. Captured live fixture compatibility is tested. This is a known incompatibility with the abbreviated published example, not a claim that every upstream variant is accepted.

The official [referral example](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-referral-information) uses one flat `tokenToState` pair; captured fixtures and a fresh public zero-address read contain nested pairs. Both are validated; the single pair is normalized to the application's nested representation. Ready/needToTrade/needToCreateCode captured fixtures pass; unknown stages fail closed.

## Verification

- API full regression: 51 files / 560 tests passed; the two subsequently added fixture compatibility regressions also pass (focused upstream suite 11/11).
- Web unit/SSR regression: 14 files / 62 tests passed.
- API and web typecheck/lint passed; final web production webpack build passed.
- Dependency compatibility: 3/3 passed; audit reports zero known advisories. Existing Privy/Farcaster optional-module warning remains tracked by E18/E20.
- Chromium fixture E2E: 6/6 passed. Production Docker image built with frozen lockfile; isolated image migration/readiness (HTTP 200)/graceful shutdown (exit 0) passed. No remote CI/deployment verification claimed.

## Second batch: E07–E09 (base e8d7bc1)

- Claude concurrently advanced its own branch to 42fe055 (trade definition and trader tabs). This batch only touches HTTP boundary/authenticated action streams and avoids those files.
- E07: observed two RED regressions for legacy private-column exposure and invalid DTO acceptance; the shared allowlist now validates registered legacy responses too, while preserving raw body shape and existing health/file/HEAD/204 exceptions. Focused tests GREEN (10/10).
- E08/E09: observed RED for disabled/expired private streams, unbounded initial queue and stuck setup; each subscriber now reauthenticates before deliveries/heartbeats with a deadline, buffers bounded UTF-8 bytes, clears pending frames and releases slots on failure. Focused initial regressions GREEN (24/24 including HTTP).
- Ruling: reauthenticate using the existing AuthService and original token, preserving persisted role/disabled-state reads and JWT expiry checks; no unverified JWT decoding or new authorization cache. Idle detection is bounded by heartbeat + check timeout, not an immediate remote-session-revocation promise.
- Ruling: use independent per-subscriber drains after shared DB lookups. A new regression showed awaiting all private authentication before fanout blocked public events; per-subscriber queues cover both replay initialization and later reauthorization. Global ID batching and multi-replica coordination remain E13.
- Ruling: close timed-out setup and suppress late results without claiming SQL cancellation; existing database statement/driver timeouts still bound already-started work.
- Ruling: health/non-JSON responses preserve their existing special behavior; unregistered legacy handlers preserve compatibility, while CI asserts all production controller routes have a registry contract.
- Fresh-context review found a drain-finalizer race that could strand the last queued frame. A deterministic scheduler regression reproduced it RED; the finalizer now resumes pending delivery, GREEN.
- Full API regression: 52 files / 571 tests passed, including authorization storage failure, delayed replay after disablement, idle expiry, hanging authorization isolation, setup timeout, overflow and the finalizer race. Web regression: 14 files / 62 tests passed.
- Three initial route-auth failures came from old non-contract stub payloads, not valid production DTOs. Leader routes now use the real service/repository and assert actual per-user alert isolation instead of echoing mock scope.
- API typecheck, lint, compiled build and HTTP docs freshness passed. Full compiled Nest app bootstrap returned readiness 200 with the owned test database and 503 with the database offline; graceful shutdown and test DB cleanup passed.
- Scope limits: E16 real Privy/JWKS rotation and deployed proxy behavior remain unverified; no real notifications/trades, production migration, remote push or deployment performed.

## Third batch: E10 (base 1e35ff3)

- Ruling: dex discovery, tracked/favorite ownership, spot balances, account mode and the price book remain required because their failure prevents a reliable accounting scope. Individual perp dexes, staking, leaderboard metadata and recorded analytics degrade independently, each with a 4s response deadline. A failed required profile request no longer replaces the independent portfolio chart with a page-wide error.
- Missing perp or staking inputs produce null account totals (and null complete-perp totals when a dex is missing); available positions and independently verified spot value remain visible. No guessed subtotal is presented as whole-account equity. Position counts are qualified and failed analytics are distinguished from an unwatched address.
- Additive dataQuality records per-source availability, observation time and freshness budget. Cache observation times survive hits; leaderboard time comes from the stored import and freshness budget uses its configured refresh interval. fetchedAt still means profile assembly, not every source's update time.
- Partial profiles cache for 5s (complete profiles 60s), and the browser retries partial profiles every 5s. Optional timeouts do not claim to cancel shared upstream work; existing upstream deadlines/budgets still apply, and late cache completion can help the next refresh.
- Ruling: while REST data is partial, suppress the numerical WebSocket overlay and show polling status until a complete snapshot is recovered. This deliberately trades some live updates for preserving unknown totals; live fills remain separate.
- Nullable profile totals require deploying updated consumers before the API. Existing numeric-only third-party clients must update; absence of the new metadata remains accepted for older complete fixtures.
- Required-source failure, malformed data, and unknown account modes are not turned into empty accounts. Upstream tokens without a price and full historical completeness remain separately tracked issues, not fixed by this batch.
- Tests observed RED→GREEN for single-dex failure, staking failure, source observation age and preserving portfolio history after profile failure. Added coverage for short-cache recovery, source timeout/late rejection, analytics outage and false-zero live overlay.
- Fresh-context review found that response-time stale flags freeze between polls. A mounted fake-clock regression reproduced it; ProfileQuality now re-evaluates age with the shared 30s browser clock. Analytics failure copy was also corrected with an SSR regression.
- API: 52 files / 577 tests passed. Web: 17 files / 67 tests passed; Chromium fixture E2E: 6/6 passed. API/web typecheck and lint, API build, final webpack production build and HTTP docs freshness passed. Compiled API bootstrap returned readiness 200 with the owned test DB and 503 when offline, then shut down cleanly. Existing optional Farcaster SDK warning remains outside this batch.
- Concurrent dev update 57ad712 adds only a Stage 3 specification; preserve it during rebase. Claude's analysis UI branch 42fe055 remains unmerged and untouched.

## Fourth batch: E11 repository boundaries (base 42061d5)

- Read actual DonutMe invoice module/repository, transform interceptor and app config validation; extract insights snapshots, profile persistence and revenue snapshot queries into module-owned repositories. Business calculations, normalization, 404 semantics and cache ownership remain in services.
- Ruling: preserve Drizzle and existing SQL behavior; use existing real-database behavior tests for this mechanical refactor rather than introduce tests that mirror the extraction. No new behavior or RED→GREEN claim. Cost if the boundary is unsuitable: small module-local refactor; remaining transactional auth/admin/Telegram work is not marked complete.
- Ruling: avoid Claude's unmerged analytics branch 681f8c4 while establishing the parity acceptance matrix. Its documentation reports sample-fitted thresholds; do not declare proprietary formulas or true execution equivalent. Cost: functionality remains pending integration and independent acceptance.
- Added Copydog acceptance matrix separating UI, calculations, coverage, live provider verification and real execution. Current public page retrieval failed; no fresh live parity claim.
- Initial full regression exposed missing repository providers in two manually assembled HTTP test modules; registered them against the same real database. Final full API run: 52 files / 577 tests passed. API typecheck, lint, build, HTTP docs freshness and diff checks passed. Compiled full-app bootstrap returned readiness 200/503 and cleaned up its isolated database.
- Fresh-context whole-batch review: no correctness findings; no deferred minors. No frontend, migration, dependency or wire-format change in this batch, so frontend/dependency checks were not repeated. No push/deployment or real notification/trade.
