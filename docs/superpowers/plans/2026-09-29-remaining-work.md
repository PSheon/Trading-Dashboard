# Remaining audit implementation ledger

Base: 4af4fa6. User authorized execution of the 40-item ordered backlog and local dev integration. Work in codex/audit-fixes; never change Claude worktrees or use application databases. No remote push or deployment.

## Sequence

1. Alert payload contract and UI: version new payloads, parse historical nested/flat shapes, verify real persisted JSON.
2. Actions cursor: stable timestamp/id ordering, additive beforeId paired with before; retain timestamp-only compatibility.
3. Settings: serialize patches including missing rows, commit all sections atomically, prevent stale read cache publication.
4. Identity cache: stable Privy DID-scoped keys, cancel/remove previous identity queries and reset identity-dependent UI; abort browser requests.
5. Imports: validate addresses, positive integer ranks and bounded input before DB/backfill; preserve alias/dedup behavior.
6–12. Shutdown, readiness, deadlines, Telegram retry, scheduler, outbox and cooldown.
13–24. HTTP contracts, validation, DTOs, documentation, repositories/module boundaries and config DI.
25–31. Rate limits, revocation, UI permissions, audit, Privy tests, logs and HTTP security.
32–40. CI, disposable DBs, E2E, dependencies, images/migrations, performance, accessibility, backup validation and documentation.

Each task gets regression evidence and validation recorded below. Batch integration follows green tests, independent review and clean-dev checks. External infrastructure facts must be recorded as unverified when credentials/access are unavailable; do not invent deployment/backup proof.

## Batch 1 evidence

- Task 1: version regression failed before fix; NotifyService + historical reader tests 11/11 passed. New payloads have version=1; historical unversioned nested/flat payloads remain readable, unknown future versions display no guessed values.
- Task 2: two cursor regressions failed before fix; cursor + real HTTP routes 21/21 passed. Additive beforeId preserves legacy timestamp-only cutoff behavior.
- Task 3: deterministic overlapping writes and a DB constraint failure reproduced both lost updates and partial commit; settings/admin-settings 19/19 passed after transaction lock + commit-time cache invalidation. Earlier draft tests did not force overlap and used an invalid announcement shape; those were corrected before implementation.
- Task 4: delayed token and uncancelled fetch regressions failed before fix; three web tests pass, including retired-client late writes. Web typecheck passed.
- Task 4 Ruling: isolate the entire QueryClient and remount its UI subtree by Privy DID instead of adding DID to every individual query key. This also contains pending mutation callbacks and form/link state; cost is refetching public data on identity changes. Stable DID, not email/wallet, selects the session boundary.
- Task 5: import regressions produced nine failures before fix; imports + HTTP routes 36/36 passed. Accept existing column aliases and lowest duplicate rank; reject invalid address/rank, empty or >1000 rows, and serialized request >100 KiB before writes/backfill.
- Request cancellation behavior was checked against https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation . The API wrapper aborts requests at identity transitions even when a caller omits the optional query AbortSignal.

- Independent read-only review: no blocking findings. Added the two identified coverage gaps: old Settings read resolving after commit, and mounted React StrictMode direct account-switch/logout tests (private query data, local draft state and late writes to the retired client).
- Batch verification: API full suite 406/406, plus new stale-read regression 8/8 settings tests; web 4/4 tests; API/web typecheck, API lint and both production builds passed. Web lint rerun after correcting the test createElement children convention.

## Batch 2 runtime work

- Tasks 6–10: shared background job tracking, stop admission, cancel upstream/queue waits, seed retry cleanup, DB drain/connection closure and a 30-second process watchdog starting on SIGTERM/SIGINT. Existing Telegram poll shutdown now stops consuming the rest of a fetched update batch after cancellation.
- Runtime pool uses 3s connection wait, 15s PostgreSQL statement/idle-transaction limits and 20s driver query timeout. Background drain is bounded at 25s; pool close gets 3s then force-closes tracked connections. The total process watchdog bounds other stuck lifecycle hooks. Deadline expiry may interrupt unfinished work; this is not durable notification delivery.
- Public /health heartbeat remains; /health/ready probes DB and returns 503 on failure/shutdown. Railway healthcheck path updated in source (not deployed).
- Task 8 Ruling: queue cancellation and Telegram default timeout were pulled into task 6 because otherwise shutdown could wait indefinitely. HTTP AsyncLocalStorage supplies caller cancellation + a 20s overall deadline to nested Hyperliquid calls; explicitly admitted background jobs detach from HTTP scope. Each upstream info call also has its own 20s bound and the queue caps at 1000.
- Telegram waits at least retry_after; delays >60s fail the current delivery instead of retrying early. Long polling gets its declared timeout +15s, other calls 15s. Body transport errors remain transient; shutdown cancels retry sleeps.
- Snapshots coalesce overlapping runs with concurrency 4; success timestamp advances only after actual writes, attempt/failure timestamps are separate. Sweeps use concurrency 4 and retain another pass when a catch-up arrives during a run, including newer windows.
- Regression evidence: seed retry failed before fix; queue cancellation/overflow two failures before fix; Telegram retry_after failed before fix; scheduler overlap/concurrency failed before fix. Reviewer found lost overlapping catch-up window, unbounded pool close, body timeout misclassification and missing caller propagation; each has a reproduced failing test followed by passing fix.
- Compiled real bootstrap probes: isolated healthy DB -> /health/ready 200; unavailable DB -> 503; SIGTERM terminated both within 0.02s. Final rebuild/probe after review fixes remains to run.

- Final runtime verification: 37 API test files / 422 tests passed; API typecheck/build/lint passed. Rebuilt real-bootstrap probes again returned 200/503 as expected and both exited on SIGTERM in 0.01s. Existing web tests/typecheck rerun for the additive heartbeat fields.

## Batch 3 durable delivery

- Tasks 11–12: transactional action outbox and per-recipient delivery intents, leased claims, bounded retry and terminal failure, DB cooldown reservations and admin aggregate status. Backfill never enqueues historical alerts.
- Evaluation context persists equity at action creation; replay preserves percentage-rule behavior with an empty watcher cache. Each external retry checks current user, channel and notification policy. All failures retain Telegram Retry-After, including the last immediate attempt.
- Isolated test DB migrated through 0008. No application/production DB migration or external Telegram send performed. Recovery, transaction rollback, concurrent claims/reservations, expired leases, revocation, percentage replay and final-attempt delay covered.
- Verification: 38 API files / 433 tests passed; API typecheck, lint and production build passed. Independent review's three findings fixed and reviewed again without blockers.
- Operational limits and duplicate-on-crash ambiguity documented in notification-delivery.md. Retention automation and actual deployment remain outstanding.

## Batch 4 HTTP contracts

- Tasks 13–18: negotiated X-API-Contract:1 success/error envelopes, stable business codes, normalized field paths, strict output registry for every controller route, Date/BigInt JSON serialization, DTO allowlisting and browser/fixture validation. Legacy unnegotiated clients retain bodies; no deprecation date is invented.
- Health, streams, HEAD and 204 bypass envelopes. Proxy forwards contract/request/retry metadata, propagates cancellation and handles broken response bodies. Request IDs were pulled forward from task 30 because envelopes require correlation; structured logging remains later.
- Shared common validation replaces feature-specific helpers. Browser types distinguish string timestamps/IDs from domain Date/BigInt; generated route docs have a freshness check and controller-to-registry coverage test. Dynamic JSON fields intentionally remain extensible and scoped by existing ownership rules.
- Verification: 39 API files / 444 tests passed; web 11 tests passed; API/web typecheck and lint passed; API build passed. Real DB v1 probes cover profile/favorites, discovery and admin reads; loopback probes cover precision, unknown-field stripping, errors, parser failures and legacy compatibility. Web probes cover network/fixture validation, 204 deletes and proxy metadata/body failure.
- Independent review: fixed fixture undefined serialization and parser 413 handling. Installed Nest already translates SyntaxError to400; pre-route400 messages now sanitized. Follow-up review has no blockers.
- Frontend production build: default Turbopack failed because this environment denies the CSS worker's temporary port binding, including the escalated retry. Installed Next CLI docs confirm `--webpack`; that production build passed, including TypeScript and route generation. Default-bundler validation remains an environment limitation, not a claimed pass.

## Batch 5 architecture

- Tasks 19–23: feature repositories for settings/favorites/alerts/leaders/discovery; explicit UnitOfWork handles; pure rule policy; on-demand IngestionModule separated from watcher bootstrap; discovery cron/startup moved into explicit worker composition; shared contracts/database subpaths and ORM-free enums.
- Ruling: retain supported single-process AppModule and worker-aware health diagnostics; prove reusable feature imports have no background startup rather than introduce an unrequested API-only deployment topology.
- Targeted pre-rebase settings/favorites/route/snapshot tests 53/53 passed, typechecks passed. Full run interrupted by the user; restarted before reconciliation. Final verification and independent review are still pending.
- Concurrent dev changed to 89ce646 (Claude TWAP fill recovery and cold-page latency work). Preserve those commits during rebase; do not integrate this batch until combined behavior is verified.
- Pre-rebase full run resumed successfully: 40 API files / 446 tests passed; shared build, API typecheck/build/lint passed. Final combined-tree verification remains required after rebasing Claude's new commits.

- Combined-tree verification after rebasing onto Claude commit 89ce646: 40 API files / 463 tests passed; web 11 tests passed; API/web typecheck and lint, API build and web webpack production build passed. Contract documentation freshness check passed. Actual compiled Nest bootstrap on an allocated loopback port returned readiness 200 and terminated promptly on SIGTERM (Nest re-emits the signal; subprocess return code -15). Independent review found no blocking regression in transactions, ownership predicates, module composition, TWAP mapping or cold-page behavior.

## Batch 6 configuration

- Task 24: RuntimeConfigModule injects a deeply frozen AppConfig snapshot into authentication, database, HTTP/upstream clients, Telegram, runtime jobs and ingestion. Pure action helpers receive alert horizons explicitly; no production service imports dynamic env readers. Telegram system chat ID is included in the validated snapshot.
- Test fixtures explicitly inject a mutable double for historical tests that alter env within a case; production has no optional env fallback. Added mutation isolation and real-client snapshot regression tests. Initial new-config test failed before implementation; parser/config tests now 38/38. Actual compiled application resolves the new dependencies, returns readiness 200 on the isolated DB and exits promptly on SIGTERM.

- Task 24 verification: 41 API test files / 466 tests passed; API typecheck, lint and production build passed. No frontend contract changes. Initial full run caught one obsolete direct pool-factory test, which now tests validation before construction; targeted and full reruns pass.

## Batch 7 security — in progress

- Task 25: pre-auth IP and verified-caller/category request limits, bounded active bucket memory, 429/Retry-After, explicit proxy IP/CIDR trust and per-user monitored-favorite quota with transactional row locking. Per-minute defaults and restart/multi-replica/anonymous-proxy limitations are documented in rate-limits.md.
- Ruling: default to no forwarded-IP trust instead of copying DonutMe's numeric Fastify proxy hops. Deployment topology is not verified; cost is a shared anonymous allowance behind the current Next forwarder. Account quotas do not claim a global cap across users or privileged imports. No live proxy policy was changed.
- Targeted limiter/real-DB favorites tests: 25 passed, including simultaneous last-slot additions, idempotent retries and no rejected backfill. Added actual HTTP envelope/Retry-After probe and strict environment regressions before the full gate.

- Task 25 full gate: 42 API files / 477 tests passed; API typecheck/build/lint passed. Real HTTP probe verifies forged forwarded IP cannot bypass the default limiter and v1 429 retains Retry-After.

- Task 26: every cached or freshly resolved human caller rechecks persisted role/disabled state. Profile-fetch completion is followed by another DB authorization read; protected routes fail closed on DB errors. Two new revocation tests failed before implementation; targeted auth/admin tests passed 55/55 afterward. Added a deterministic disable-during-profile-lookup regression. This guarantees freshness at the authorization read, not cancellation of business operations already admitted before a concurrent commit, and does not claim provider-side Privy session revocation.

- Task 26 final targeted gate: auth/admin tests 56/56, including disable while profile lookup is paused; API typecheck passed.
- Task 27: /me returns effective permissions from the shared catalog; frontend navigation, route content and administrative write controls consume them, deny absent/error states, and refresh /me every 30 seconds. Existing role remains for display, not authorization inference. API-before-web rollout is documented; no dynamic custom-role model is introduced.

- Tasks 26–27 combined gate: 42 API files / 479 tests and web 13 tests passed; mounted AdminShell tests cover effective grants, hidden navigation and stale-data denial on errors. API/web typecheck and lint, shared/API builds and web webpack production build passed; HTTP docs freshness passed.

- Task 28: migration 0009 adds successful administrative audit events for user roles/disable, settings, rules, leader edits and imports in their business transaction. Actors survive account deletion; no raw token/header/upload content is logged. Forced audit failures roll back user/settings changes. Full API gate: 43 files / 482 tests; typecheck/build/lint and route-doc check passed. Only the isolated test DB was migrated.
- Ruling: drizzle-kit 0.28 cannot resolve the extracted NodeNext .js imports in TS schema input. db:generate now compiles shared first and the config reads dist/schema/db.js, preserving TS as source of truth. Reproduced generation failure and successful generation/migration recorded; build-before-generation is now required.
- Task 29: real installed Privy SDK tests use ephemeral ES256 keys, cover claim/signature/algorithm rejection and pinned-key restart rotation, and assert no network access. Added HTTP guards proof that signed token role claims cannot grant database permissions. This does not claim live provider login or remote JWKS rotation verification.

- Task 29 targeted gate: 12/12 actual SDK/HTTP tests passed; API typecheck/lint passed. The HTTP test proves DB promotion and disable are observed without clearing the verification cache.

- Tasks 30–31: request context includes correlation IDs, bounded/redacted JSON logging, route/status/duration records without raw request content, API and frontend security headers, and exact-origin CORS configuration. Same-origin proxy remains supported; direct browser integrations must configure API_CORS_ORIGINS. Frontend CSP protects frame/base/object only; script/connect restrictions require verified Privy origin inventory.
- Ruling: extend fixture exclusion to webpack after discovering the existing alias applied only to Turbopack. This preserves the production fixture boundary in the sandbox build fallback; default bundler environment limitation remains explicit.
- Combined gate through task 31: 46 API files / 500 tests and web 13 tests passed; API/web typecheck/lint and production builds passed (web webpack). Compiled isolated API returned readiness 200, matching request ID and security headers; JSON request log correlation verified and process exited on SIGTERM.

## Batch 8 CI and reproducible verification

- Tasks 32–34: committed-SHA GitHub Actions workflow, Dependabot, per-run random migrated databases with explicit loopback parent validation and cleanup, compiled API readiness/shutdown runner, and Chromium session/public-discovery smoke tests. Test-mode bootstrap and browser servers skip repository .env loading.
- Verification: isolated API 500/500 and concurrent separate run 21/21; deliberate failing filter still removed its owned DB; URL guards 7/7. Compiled healthy/unavailable DB probes returned 200/503 and shut down gracefully. Browser tests 2/2 passed after cleaning this worktree's interrupted server; Claude's server was untouched. Workspace typecheck/lint passed.
- Limits: workflow has not run remotely; browser auth uses fixtures, with actual Privy SDK token validation covered separately. Browser bundle reports missing optional Farcaster Solana integration; dependency assessment follows in task 35. Next added its separate .next-e2e generated type directories to tsconfig.

## Batch 9 dependency maintenance

- Task 35: Drizzle ORM 0.45.3 / Kit 0.31.11, ws 8.22.0 with bounded same-major override, removed unused Nest Cloud tooling, native Vitest alias resolution, Node 22 typings/.nvmrc, shadcn build-only placement. Full isolated API 500/500, workspace types, web 13 tests and no-op schema generation passed. Production build is repeated with the image work next.
- Audit improved from 8 high / 15 moderate / 4 low to 0 high / 4 moderate / 0 low. Remaining esbuild/uuid/URI-decoder paths and wallet peer warnings are explicitly tracked in dependency-maintenance.md; no unsafe major override or blanket advisory ignore. This is not a claim of zero vulnerabilities or live wallet compatibility.

- Post-browser lint initially included generated .next-e2e bundles. Added explicit generated-output ignores; source lint is rerun before the next gate.

## Batch 10 image and release migrations

- Task 36: pinned Node image, API/shared-only build and production dependency deployment, non-root runtime, explicit locked migration command bundled with SQL/journal, Docker update tracking and CI image build. No automatic migration at API startup.
- Local Docker build passed; runtime excludes compiler/test/frontend packages. Image migration/readiness 200/graceful exit 0 passed against a created-and-dropped DB; concurrent local migration retries preserve journal count. Web webpack production build passed after dependency changes. Generated-output lint exclusion fixed and workspace lint passed. Production release-hook setup and external deployment remain unverified.

## Batch 11 performance

- Task 37: bounded 200-address metadata/round-trip batches, address-scoped fill PnL, stable timestamp/id ordering, capped fill bind lists and two query indexes (migration 0010). The new 12-leader test failed at 133 queries before the change and passed at 4; cross-address shared tids and latest-flat snapshot semantics are covered.
- Full isolated API 47 files / 501 tests passed, then the added empty-history/latest-snapshot case passed (2 targeted tests); API typecheck/lint passed. Synthetic 100k-row latest-action EXPLAIN changed sequential scan to new index (8.254 ms → 0.074 ms in one local run). These numbers do not represent production latency. Full-history memory and index rollout limits are documented; no production DB altered.

## Batch 12 accessibility

- Task 38: browser Axe checks at 1280/390px and signed-in admin/settings routes; corrected secondary-text contrast, redundant SVG semantics, scrolling-table focus, tab/panel relationships, roving tab/radio keyboard focus, mobile export label and translated skip link. Keyboard and initial Axe tests failed before fixes.
- Five combined browser tests passed, then the added signed-in route scan passed; web typecheck/lint passed. No full WCAG certification or live Privy modal/device-reader coverage is claimed. Existing Playwright TS runner was reused for CI rather than introducing a second Python test stack.
