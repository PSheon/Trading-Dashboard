# Admin implementation progress

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

1. Finish freshness policy/applied-runtime reporting alongside batch 3 settings consumers.
2. Batch 2: durable initial backfill work, worker-only execution, paginated jobs and safe retry; fix process-local warm-cache ownership. Keep historical fills out of live alert emission.
3. Batch 3: remaining discovery controls, impact preview, consumer-applied revisions and audit query UI.
4. Batch 4: trader detail, data source membership and import preview.
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
