# Admin implementation progress

> 發布規則（使用者最新指示）：後續工作僅限本地實作與驗證。使用者完成本地確認並明確允許後，才可部署；不得沿用過往 Stage 授權，也不得直接上傳未審查工作目錄。分支整理／rebase／提交狀態須先明確列出。

Approved sequence: `admin-capabilities-analysis-2026-09-30.md`, section 11.

## Batch 1 — monitoring foundation (2026-09-30)

Implemented:
- Protected `GET /admin/system/overview`, requiring `admin.access`, with a shared wire contract and OpenAPI documentation. HTTP responses use `Cache-Control: no-store`.
- Separate API process status, PostgreSQL probe and remote worker state. Worker reports an instance ID, sampling time, uptime and active/standby/stopping state through private `/health/monitor`; it exposes no business controls.
- API/worker budgets remain separate: weight used, configured/effective limits, queued live/background requests and last 429.
- Persisted leaderboard size/latest update, active watched addresses, discovery candidate coverage, refresh-error count and oldest/newest available portfolio timestamps. Missing data is not included in timestamp bounds and is not reported as zero on query failure.
- Both outboxes expose pending, processing, terminal failed, due pending, expired processing leases and oldest scheduled due time. Due age is based on current retry scheduling, **not original event age**.
- Independent section failures, bounded database statements, 3-second worker fetch timeout, validated worker payload, stale detection after 30 seconds (or a timestamp more than 5 seconds in the future), 5-second server snapshot reuse and concurrent-request coalescing.
- Admin system UI, Traditional Chinese/English, 15-second refresh, manual refresh, loading state and retained previous sample with a warning on fetch failure. Split-worker feed details use the same worker sample; combined development mode retains the local heartbeat.

Validation:
- API: 70 files / 786 tests passing, including real isolated PostgreSQL queries, 401/403 authorization, nullable telemetry, pool release, malformed/old worker payload and concurrent polls.
- Web: 28 files / 115 tests passing; monitoring rendering test also rerun after the heartbeat extraction.
- Playwright: 1440px and 375px layouts, manual refresh and WCAG A/AA checks passing.
- Worker process smoke: active/standby telemetry, separate instance identities, singleton handoff, API shutdown independence, loss-of-lease fail-stop all passing.
- API build/typecheck/lint, web typecheck/changed-file lint, OpenAPI export/check and whitespace checks.

Limits / remaining work:
- This is a sampled snapshot, not uptime history, a fleet-wide worker registry or externally checked availability. During rolling deployment it describes whichever instance the private service routes to.
- Data timestamps and coverage are visible; policy-based per-source freshness thresholds and applied settings revisions still need to be added. Availability counts are explicitly not freshness counts.
- No new database migration in this batch. No notifications or execution actions are triggered by monitoring.
- Privy's existing optional `@farcaster/mini-app-solana` dependency warning occurs under the webpack development test server; Google/wallet configuration was not changed by this batch.

## Remaining sequence

1. Freshness policy and discovery consumer reporting: completed in batch 3 below; broader consumer coverage remains outside this batch.
2. Batch 2: complete and verified on Stage below.
3. Batch 3: complete and verified on Stage below (discovery consumer coverage).
4. Batch 4: read-only trader diagnostics (4a), source evidence center and list-import impact preview (4b) implemented locally; full current multi-source membership/lifecycle, source controls and KOL preview remain.
5. Batch 5: user detail, narrower operational permissions and notification diagnostics.
6. Batch 6: historical metrics, external probes, alert deduplication/recovery and incident workflow.
7. Batch 7: revenue improvements and separately scoped paper/testnet administration. No live execution is implied.

Deployment evidence is recorded below after each submitted deployment reaches a terminal state.

### Stage release and startup regression

- API monitoring deployment `ba998f6a-760a-4259-977f-3c9708670380`: SUCCESS.
- Web monitoring deployment `1e77bf04-470c-4ae7-9289-dbe16cc2bd5e`: SUCCESS.
- Initial worker monitoring deployment `8d0fa770-3b4a-4e16-8344-e63b20c8ef85`: SUCCESS.
- Public checks: `/`, `/admin/system`, `/api/hl/health/ready` return 200; anonymous `/api/hl/admin/system/overview` returns 401. Authenticated admin behavior is verified locally with the real guards and isolated PostgreSQL; no user's live Privy session was used.
- Deployment observation: worker active at 14:54:23 UTC, feed still 0/0 at 14:58:11, recovered to 329 markets at 14:59:18. Background metadata loading shares the budget with history and cache warming. A focused real-budgeter regression reproduced head-of-line delay behind a heavy history request.
- Follow-up fix: `TradeFeedService.listMarkets` requests its bounded catalog calls in the live lane. Other callers of `meta` remain background by default. Existing weight accounting, rate caps, backoff and background fairness remain in force.
- The startup regression fails with the previous ordering and passes with the fix. Related live WebSocket/reconnection/budget tests: 3 files / 19 tests passing. Typecheck/lint and API build pass. The earlier 786-test full run preceded this small priority fix.

### Batch 2 implementation constraints confirmed from callers

- Both `ImportService.importLeaderList` and `FavoritesService.add` currently commit leader creation before calling the in-memory `BackfillService.trigger`. The durable queue insertion must move **inside the existing transaction** that creates the leader, not merely replace the later fire-and-forget call with another async call.
- Keep list import's manual leader edits, favorite reactivation semantics and audit transaction intact. Use a chain/address/job-kind idempotency boundary for initial backfill.
- Worker claims need lease ownership/fencing, bounded retries and a recoverable pending state after process loss. API admission must not start fill sync; read-only admin job queries must not start work either.
- Reuse `FillSyncService.sync(address, "backfill", 0)` semantics so replayed history does not become live notifications; separately retain analysis archive checkpoints.
- Job queries require bounded pagination/filtering. Retry is a permission-checked mutation with audit and an expected prior state, not an unbounded "retry everything" action.
- `TradersWorker` currently owns `TradersService.startWarming`, while its cache is process-local. Fix the ownership deliberately (or persist a shared derived cache); moving startup hooks blindly risks restoring API ingestion.

### Follow-up deployment status

The startup-priority follow-up `railway up` returned `FETCH_ERROR: error decoding response body` without a deployment ID. Two subsequent scoped deployment-list reads also failed with the same decode error. Its deployment outcome is **unconfirmed**; do not assume it was accepted or blindly resubmit. First inspect the worker's latest deployment history when Railway management API responses recover. The three monitoring release IDs above were individually observed as SUCCESS before this failure. The startup-priority code and regression test remain saved locally.

Final application probe at 2026-09-30T15:02:33Z: readiness 200; heartbeat 200, feed connected, 2/2 sockets, 329 markets, latest trade at 15:02:33.180Z, last sweep at 15:01:25.666Z; anonymous monitoring access 401. This verifies the running application despite the management API error, not acceptance of the startup-priority follow-up deployment.

## Batch 2 — durable initial backfill and jobs center

Implemented:
- Migration 0014 adds durable initial-backfill jobs, unique by chain/address. Import/favorite admission and enqueue share the existing transaction; repeated imports do not enqueue duplicate work. Existing addresses are not retroactively queued.
- Worker-only execution with SKIP LOCKED claims, 90-second leases renewed every 20 seconds, fenced state writes and three attempts per retry cycle. Manual retries preserve cumulative attempts and restart the cycle; historical replay remains silent and idempotent at persistence boundaries.
- Permission-separated jobs.read/jobs.retry, bounded cursor pagination, status filtering, expected-version conflict detection and transactional audit. Lease tokens never appear in public DTOs.
- Admin jobs UI with five-second polling, mobile layout, loading/error states, lease-expiry display and an explicit queued response for retries.
- Independent worker no longer warms an API-inaccessible process-local cache. API remains on-demand; local combined retains warming.

Validation:
- Web: 29 files / 117 tests passing; Playwright desktop/mobile jobs flows and accessibility: 2 passing.
- Local isolated PostgreSQL migration smoke passes fresh migration and concurrent migration idempotency. Worker smoke passes active/standby, handoff, API independence and lease-loss fail-stop.
- API: 74 files / 796 tests passing, including atomic admission, lease fencing/recovery, bounded retries, concurrent manual retry conflict, audit and HTTP permissions. API build/lint and OpenAPI check pass; web typecheck and changed-file lint pass.
- Stage release evidence follows below.

Limits:
- These jobs cover initial watched-trader fill backfill only, not all discovery/snapshot/analysis work.
- At-least-once replay, not exactly-once external requests or a guarantee of complete lifetime exchange history.
- Policy-based freshness and applied settings revisions remain batch 3. No real notification sending or trading execution is enabled.

### Batch 2 Stage release

- API `27f4d24a-5713-43c4-a503-5f13a27ba583`: SUCCESS; readiness 200 and anonymous jobs endpoint 401 verified.
- Worker `87501d5c-baab-414a-ba5e-d237e04f4977`: SUCCESS; active at 2026-09-30T15:24:48.184Z.
- Web `05dd492f-817e-49e2-b6f0-65e4123668be`: SUCCESS; `/admin/jobs` returned 200 at 2026-09-30T15:26:04.686Z.
- Railway management reads recovered. Prior monitoring redeploys were observed before this release (API `f6a010e3-f8e5-47b4-a7ce-315a6ee4b813`, worker `a0656624-8f0c-4d2b-9fcb-479b867bbef5`); they are not evidence for the earlier startup-priority upload. This batch's source includes that priority fix.

- New worker heartbeat at 15:25:11 UTC: connected, 2/2 sockets, 329 markets and a current trade timestamp, about 23 seconds after becoming active. This release includes the startup-priority fix; no home-cache warming runs in the standalone worker.
- Public `/` and `/api/hl/health/ready` returned 200; anonymous `/api/hl/admin/jobs` returned 401. The jobs page briefly returned 404 before web cutover and was rechecked successfully afterward.
- Stage predeploy migrations completed as part of successful API/worker releases. Durable queue transitions and authenticated admin controls were exercised locally against isolated PostgreSQL; no live Privy admin session or artificial Stage import was used. No claim is made that a new real Stage backfill was processed during this verification.
- Temporary local PostgreSQL test server stopped after verification. Changes remain uncommitted for review.

## Batch 3 — settings control and audit (verified on Stage)

Scope: remaining discovery controls, visible before/after impact preview, worker consumer acknowledgements, explicit freshness policy, and read-only paginated audit search.

Rulings:
- Keep batch 2's uncommitted work intact on dev. No unrelated cleanup or automatic production configuration changes.
- Consumer acknowledgement is process-local and carried by the existing private worker sample/instance identity. A read or saved revision is not an acknowledgement; restart returns unknown until a consumer acts. Acknowledgement means the scheduling policy/pool membership was accepted, not that every trader has refreshed.
- Settings impact preview is a local draft comparison with explicit scheduling/budget implications, not a claim about exact future membership or completion time. Existing section revision preconditions remain authoritative on save.
- Freshness policies are explicit monitoring defaults (leaderboard 60 minutes, portfolio/trade metrics 24 hours), separate from null coverage. They do not trigger alerts or change collection cadence.
- Audit exposes only recorded allowlisted mutation fields, with bounded filters/keyset pagination; no raw request bodies, secrets, or invented service identities.

Implemented:
- Discovery form now exposes candidate pool size, per-minute pool weight, ordered crypto/stock boards and existing controls. Board lists preserve editable text, normalize empty entries and duplicates, and retain shared validation.
- Every section shows a live before/after draft preview and its operational implications. Preview performs no mutation; saves still submit only changed fields with the original section revision.
- `GET /admin/settings/runtime` requires settings.read and no-store. It compares the committed discovery revision with explicit pool/leaderboard acknowledgements in the sampled worker. Unknown, stale (>3 minutes), recovered and pending states remain distinct. It does not pretend to cover all settings consumers.
- Pool size changes bypass the ten-minute periodic rebuild delay. An empty leaderboard cannot falsely acknowledge a new pool build. Zero budget maintains membership but pauses new data refresh and resets saved allowance.
- Monitoring adds independent stale/missing counts under explicit fixed thresholds: leaderboard 60 minutes, portfolio/trade metrics 24 hours. These are monitoring defaults, not configurable SLOs or external availability probes.
- `/admin/audit` and `GET /admin/audit` require audit.read; filters cover event, actor kind, actor user ID and exact target. Cursor IDs remain decimal strings, queries are read-only with a 2-second statement timeout, and the UI renders values as escaped text. Existing audit writes remain transactional.
- No new migration beyond batch 2's 0014 and no Stage setting values are changed as part of verification.

Validation so far:
- Web: 30 files / 119 tests passing; typecheck and changed-file ESLint pass.
- Desktop/mobile Playwright settings edits, non-mutating preview, saving, audit filters/pagination and WCAG checks: 2 passing. Initial E2E selector expected “Save” instead of the actual “Save section”; corrected and rerun successfully.
- API first full suite: 76 files / 800 tests passing. Final suite adds consumer/HTTP tests and query timeout verification; results and Stage deployment IDs follow below.
- API build/typecheck/lint, OpenAPI export/check and four offline OpenAPI tests pass.

Final local validation:
- API: 76 files / 802 tests passing, including paused-pool acknowledgement after membership build and runtime HTTP 401/403 checks.
- Compiled worker smoke: active/standby exclusion, private-only routes, independent API shutdown, singleton handoff and ownership-loss fail-stop all passing.
- Final web typecheck, API/web lint and whitespace checks pass.

### Batch 3 Stage release

- API `c6fa75b5-ff70-4082-a726-8c3023cbf369`: SUCCESS. At 15:43:09–10 UTC, readiness returned 200; anonymous settings runtime and audit requests returned 401.
- Worker `c7029408-0073-4e9c-96d9-1a4c4fe81cec`: SUCCESS; active at 15:43:40.428 UTC, 329 markets on 2 sockets at 15:43:54.768.
- Web `d1005906-8f31-463c-9594-24f5a2a23652`: SUCCESS.

- Final probes at 2026-09-30T15:44:09–10Z: `/admin/settings`, `/admin/audit`, `/admin/system`, readiness and heartbeat all returned 200. Heartbeat: feed connected, 2/2 sockets, 329 markets, current trade timestamp.
- Live authenticated admin edits/audit queries were not performed using a user's Privy session. Their behavior is covered by local real-HTTP/DB tests and fixture-backed browser tests. No Stage policy values were edited for a demonstration, and no real notification sending or execution was enabled.
- Local test PostgreSQL is stopped. Batch 2 and 3 changes remain uncommitted for review.
- Next: batch 4 trader detail, data-source memberships and import preview, followed by batches 5–7 in the approved sequence.

### 2026-10-01: local-only continuation

- Following the user's latest instruction, no further deployment or remote DB/configuration operation is allowed before local review and explicit deployment authorization.
- Prioritized the missing user research flow: identity search and private favorite groups. Implementation and evidence are recorded in [the CopyDog roadmap](copydog-implementation-roadmap.md).
- Admin batch 4 remains pending; this research increment does not complete Admin trader detail/source/import preview work.
- Current branch is `dev`, HEAD `04991f3`; Admin batches 2–3 and research changes remain uncommitted. No rebase, commit, push or deployment this round.

## Batch 4a — read-only trader diagnostics (2026-10-01)

- `/admin/traders?address=…` and `GET /admin/traders/:chain/:address` provide a persisted-evidence view, guarded by the new `traders.read` permission (included in the existing admin role). Human UI entry also requires `admin.access`; service tokens need the explicit read scope.
- Shows KOL identity, official leaderboard presence, discovery membership/rank, watch configuration/source, aggregate favorite and enabled-alert references, refresh errors, initial-backfill status, analysis-history status, analytics/funding coverage and the latest 20 import records with truncation disclosure.
- Uses a read-only repeatable-read database transaction with a two-second per-statement timeout. No upstream client or work admission dependency. Unknown addresses show absent evidence rather than creating records. Errors fail the request rather than turning an unavailable DB into zero counts.
- Missing timestamps stay missing. Fill timestamps are event times, not synchronization times; watched configuration is not proof of worker connectivity; enabled alert references are not delivery confirmations. Historical imports do not establish current source membership. `caught_up` only describes a fixed history interval.
- Response projects explicit fields: no raw upstream error text, lease tokens, personal user identities or uploaded filenames. Shared response contracts and offline OpenAPI updated.
- Frontend retains existing styling, supports Chinese/English, bookmarkable address queries, 30-second polling, manual refresh and loading/error states. Desktop and mobile fixture browser tests cover address switching, evidence semantics, accessibility and overflow.
- This is the first read-only increment of batch 4. Remaining: full current multi-source membership/lifecycle, source center and import impact preview; per-source sync/cancel/recompute controls; more dataset diagnostics (positions, score model versions and detailed failure reasons). No new migration, remote database/configuration changes or deployment. Existing 0014/0015 renumbering remains Claude's integration task.
- Validation: API 79 files / 810 tests; Web 30 files / 119 tests; desktop (1440px) and mobile (375px) Playwright 2 tests; shared/API builds, web typecheck, API/changed-web lint, OpenAPI export/check and 4 offline schema tests all passed. Database tests use isolated local PostgreSQL; browser tests use Demo fixtures, not live Privy. Existing optional Farcaster dependency warning remains outside this increment.
- Developed on `codex/copydog-local-followup`; commit and local fast-forward integration into `dev` follow validation. No push or deployment is part of this batch.

## Batch 4b — source evidence center and import impact preview (2026-10-01)

- Added `/admin/data-sources` and permission-scoped `GET /admin/data-sources` (`sources.read`). Shows separate, overlapping sets for official leaderboard, discovery pool, KOL registry, active watch configuration, distinct favorited addresses and historical import versions. Each timestamp states what it measures; missing per-address live connection telemetry remains unknown. Counts are not summed into a monitored universe.
- This is a read-only source evidence center, not a completed source lifecycle/control system. Querying does not trigger ingestion, and database errors remain errors rather than zero counts. Read-only queries use a two-second statement timeout.
- Added `POST /import/lists/preview` with the existing `leaders.import` permission. Preview and actual import share address/rank aliases, semantic validation and lowest-rank deduplication through `prepareImportRows`. Request limits remain 1000 rows / 100 KiB.
- Preview classifies new addresses, favorite-to-import promotion and preserved existing leader settings. Reports duplicate/error rows and estimated new initial-backfill jobs, excluding existing durable jobs. Any invalid row blocks the entire actual import. Manual labels/notes/tiers (including tier C) remain intact; existing imported inactive leaders remain inactive; favorite-sourced leaders are promoted and activated under existing import behavior.
- Preview runs in a read-only repeatable-read transaction and creates no list, leader, job or audit row. It is advisory: concurrent changes can affect final import results; actual import validates and uses the existing atomic persistence/audit/admission transaction. No stale-preview guarantee or fixed API-cost/ETA is claimed. Existing API clients may still import directly; the new UI requires review first.
- `/admin/lists` now exposes the source name, preview summary, per-address effects and row errors. Changing file/source invalidates the usable preview; submit is disabled for invalid/unreviewed input and while pending. Async file reads cannot replace a newer file selection. Non-object JSON rows (including `[null]`) are rejected before rendering, and successful imports require a new preview before another submission. Displays at most 50 valid rows and 50 errors while totals cover the full file.
- Remaining in batch 4: current multi-source membership schema and reference-preserving removal, sync history and controlled source actions, selectable field mapping, KOL-specific preview/overwrite policy, batch operation tracking. This batch does not replace the source model or add a migration; 0014/0015 integration renumbering stays with Claude.
- Developed on `codex/copydog-local-followup`, to be committed and locally integrated into `dev` after validation. No push, deployment, remote migration or live notification was performed.
- Validation: final full API run 80 files / 814 tests; Web 30 files / 119 tests; 3 Playwright cases covering 1440px/375px preview/confirmation/source rendering and malformed JSON recovery. Shared/API build, typechecks, relevant lint, OpenAPI export/check plus 4 offline schema tests and whitespace checks pass. API tests use isolated local PostgreSQL; browser cases use Demo fixtures, not a live Privy session.
- During verification, the architectural test caught SQL transaction setup in the service; moved it into the repository. The first full run also hit one existing outbox claim timing failure; its targeted rerun and the final full suite passed without changing outbox code/tests. The browser regression reproduced `[null]` crashing the old raw preview and passes after input validation. Source fixture timestamps were corrected to the wire contract and the browser test now waits for populated source cards before checking accessibility.
