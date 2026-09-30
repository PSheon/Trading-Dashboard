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


## Fifth batch: integrate trader analytics (base 5be2e0d, Claude 681f8c4)

- Integrated Claude's four committed analytics changes into the isolated worktree. Resolved UI/i18n conflicts by retaining nullable profile totals and methodology disclosure while switching trader-page win rate to the selected-period, after-fee analytics endpoint.
- Ruling: preserve the legacy recorded 30-day gross statistic as a separate contract; do not silently change existing consumers. Cost: two documented metric definitions remain until legacy retirement.
- Ruling: use complete upstream clearinghouse states captured before history reads, not cached profile assembly time. Skip absence pruning for tracked storage because watcher completeness is unknown. Cost: extra state reads and temporarily stale tracked open trades, instead of deleting valid entry history.
- RED→GREEN: partial profile false closures, source observation time, failed checkpoint rollback, funding response validation, same-timestamp forward overflow, burst admission, invalid cursor range, funding progress/freshness, cold TWAP tail loss, and close/read ordering. API integration uses real temporary PostgreSQL with migration 0011.
- Ruling: when either forward stream exceeds its page budget, retain the previous checkpoint and return busy; do not advance a shared cursor past unread fills. Cost: high-density histories may remain unavailable pending resumable backfill (E12). Both streams now use a common fixed upper bound and independent cold starting points.
- Transaction boundaries follow the DonutMe principle: upstream work outside SQL transactions; trade writes plus summaries/cursors atomic; funding writes plus summary/cursor atomic. Single-process admission includes stale refresh/funding; diagnostic history bounded to 200 addresses. Distributed locks remain E13, not claimed solved.
- Ruling: expose fundingThrough and disclose partial funding. Historical aggregated funding cannot establish exact intraday attribution or full Copydog equivalence. Cost: consumers must respect coverage rather than treat displayed totals as complete.
- Fresh-context review found four issues: cold/shared cursor gaps, live-state-after-fill pruning race, ledger not refreshing after funding, and out-of-range cursors. All addressed; mounted ledger regression observed RED without polling and GREEN with polling. No deferred minor findings.
- Web tests now use the actual wire-serialized analytics fixture; prior fixed-30d tests were updated because the new endpoint intentionally changes trader-page period semantics. Unavailable analytics remain distinct from no closed trades. New 1440px/390px E2E cases exercise performance and trades tabs.
- Final verification: API 54 files / 611 tests; web 18 files / 68 tests; Chromium 8/8 including desktop/mobile trader tabs. API/web typecheck/lint, API build, webpack production build and HTTP docs freshness passed. Compiled full Nest bootstrap migrated the owned test DB (including 0011), returned readiness 200/503 and shut down cleanly.
- First E2E run overlapped source/shared-output changes and failed two navigations; stable-source rerun passed all eight without changing navigation assertions. Existing optional Farcaster mini-app module warning remains E18/E20.
- Incremental funding test now advances a controlled clock between reads; a completed funding page checkpoints its requested cutoff, not merely its last event. This avoids re-reading an empty interval while still testing a genuinely later payment.
- No live Copydog parity check, real Privy/Telegram/transaction execution, production migration, push or deployment performed. Retain the worktree for the next authorized batch.


## Sixth batch: settings concurrency and recovery (base 0ac2a22)

- Implements A01/A02/A05, plus shared typed recovery for A08. GET/PATCH snapshots expose per-section revisions and invalidSections; mutations require preconditions and reject unknown/empty fields. Revision checks, writes and audit remain under the same transaction advisory lock.
- Ruling: use SHA-256 of canonical stored JSON plus updatedAt, requiring no migration. These are representation preconditions, not immutable historical policy versions. Cost: A07 still needs a separate policy history design.
- Ruling: bootstrap absent rows keep defaults, but existing missing/malformed security switches fail closed. Other valid fields survive corruption. Cost: damaged/legacy partial settings may need explicit repair before enabling a switch again.
- Ruling: require preconditions at AdminSettingsService; trusted internal SettingsService patches retain optional preconditions. Cost: browser/API must ship together and old mutation clients receive 428 until upgraded.
- Ruling: reuse the recovery helper in fresh notification delivery checks to close the A08 parse mismatch exposed by A02. Business TTL cache, distributed policy enforcement and post-commit snapshot durability stay out of scope; they remain A03/A07/A12.
- RED→GREEN: initial API tests reproduced stale overwrite, unsafe fallback and accepted unknown/empty writes. Added real-Postgres concurrency, all-section conflict rollback, uncached snapshot and malformed-data cases. JSON null fixtures explicitly use jsonb null, avoiding SQL NOT NULL violations.
- Mounted UI test verifies dirty-field payloads, preserving another section's draft and original revision, 409 draft preservation, and explicit reload. Additional background-refetch failure test reproduced draft unmount, then passed after retaining cached forms and showing an error notice.
- Fresh-context whole-diff review: no Critical/Important findings. Final: minor (deferred): concurrent different-section saves may return whole snapshots out of order and temporarily regress clean displayed values; server preconditions still prevent lost updates. A03/A06/A07/A12 scope exclusions remain tracked, not resolved by this batch.
- Verification so far: API 54 files / 626 tests; web 19 files / 69 tests; Chromium 8/8; API/web lint and typecheck; API build; full compiled Nest readiness 200/503; HTTP docs freshness and diff checks. Webpack production build also passed (existing optional Farcaster mini-app module warning remains E18/E20). No production changes, pushes or real notifications/trades.


## Seventh batch: actual Nest DTO pipeline (base 287ff6c)

- User correction: response envelope / parser helpers alone did not meet the DonutMe class DTO, pipeline and decorator requirement. Re-read DonutMe validation-pipe.factory, input transforms, http/skip-transform decorators and TransformInterceptor. Added actual class-validator/class-transformer dependencies and native decorated feature DTOs.
- APP_PIPE registers a shared ValidationPipe factory through HttpModule; all production body/query/params use runtime DTO imports, with no inline Zod parsers. Added explicit SkipTransform for health/readiness/SSE and ResponseMessage for admin mutations, consumed through Reflector. Auth decorators remain independent.
- Ruling: preserve 400, negotiated envelopes, output wire allowlists and exact bigint/ISO serialization, rather than copying DonutMe's 422 or adding a second response class serializer. Cost: documented compatibility differences remain; this batch does not claim Swagger parity.
- Ruling: retain domain/service validation for internal callers, while request shape/conversion runs before controllers. Class DTO and shared input schemas are two declarations; parity tests cover representative defaults/conversions/rejections. Cost: future changes must update both, not assume automatic derivation.
- Ruling: reject unknown request/query fields and invalid root shapes; synchronize shared request strictness for fixtures. Cost: clients relying on ignored fields or empty numeric values must correct requests. Dynamic import columns and rule parameter maps remain explicit exceptions.
- Initial global-pipeline and response-metadata HTTP tests observed RED before implementation, then GREEN. A migration regression (optional class fields materializing undefined in revision records) observed RED and fixed using declare fields. Existing controller-only trader tests now execute the actual global pipe before invoking methods, preserving their raw-input coverage.
- Fresh-context review found optional native DTOs accepting empty-array roots. Real HTTP test observed RED; RequestValidationPipe now checks object shape before super.transform. Added null/primitive/array regressions and shared/native strictness parity tests (RED→GREEN).
- Final: minor (deferred): source boundary gate verifies runtime imports and Dto names, but not that imported symbols are classes; real HTTP and compiled bootstrap tests remain necessary.
- Compiled bootstrap probe now asserts invalid public query, params and SSE requests return 400/validation_error before handlers; readiness 200/503 still tested. No real Privy, Telegram send or trading execution used.

- Pre-rebase verification: API 57 files / 675 tests, web 19 files / 69 tests; typecheck/lint, shared/API builds and compiled startup/validation smoke passed. During integration, dev advanced to 2d9d424 with Claude analytics/UI changes; rebase and verification of the combined tree follow, preserving those commits.

- Rebased onto 2d9d424 without conflicts, preserving Claude's analytics and mobile card UI. Combined API suite: 57 files / 676 tests; web: 19 files / 67 tests. Initial rebased E2E correctly exposed an obsolete table-only assertion at 390px; the new mobile ledger is a semantic list. Ruling: assert rendered trade card side/share control on mobile, retain desktop table assertion and coverage/error checks. Cost: selectors follow the current responsive presentation; this does not change product code or relax data-loading checks.

- Final combined-tree verification: API 57 files / 676 tests; web 19 files / 67 tests; Chromium 8/8 after responsive assertion update. Shared/API/web typecheck, API/web lint, API build and webpack production web build passed. Compiled full Nest readiness returned 200/503 and rejected invalid DTO requests. HTTP docs freshness and diff checks passed. Existing optional Farcaster mini-app module warning remains tracked; no production migration, push/deployment, real messages or trades. Owned temporary PostgreSQL cluster removed.
