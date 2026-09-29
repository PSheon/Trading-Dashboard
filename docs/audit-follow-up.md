# Audit follow-up — 2026-09-29

This is a status ledger, not a claim that every PRD requirement has shipped.
The audit preceded concurrent feature commits; always compare the current code
and tests before implementing an item. Historical PRD and competitor PDFs are
reference material, not generated or verified by this change.

## Addressed in the audit-fixes branch

- Destructive tests use only explicit TEST_DATABASE_URL, loopback hosts and
  database names ending in `_test`; DATABASE_URL is never a fallback.
- Actions filter the normalized trader address. Legacy actions, alerts, leaders,
  list diff and import controllers parse shared schemas; limits and malformed
  inputs are rejected. Leader PATCH rejects unknown fields. Boolean query
  parsing handles `false` correctly.
- Equity and positions are persisted atomically. Legacy leader views use the
  latest equity snapshot, including flat positions. The equity history time
  window is applied in SQL.
- Fill sync retries process already-stored fills returned in the requested
  window, repairing interrupted action derivation while retaining action locks
  and deduplication. This does not recover data no longer returned by upstream
  or guarantee delivery of an in-memory notification event across a crash.
- Docker build context excludes secrets, dependencies and local artifacts.
- Root dev builds shared first, watches contracts and uses separate API/web
  ports. Turbo tracks root env files and passes appropriate dev variables.
- Migration commands load the root env file and fail on a missing DATABASE_URL.
- Root/API/web setup docs now describe real commands, isolated tests, fast path
  behavior and historical-spec precedence. The API starter README is replaced.

Claude's `3cf7d4c` already integrated activity filtering. This branch starts from
that commit and does not reimplement that feature or the Telegram redesign.
Claude's `38ce99e` implements the Telegram redesign, with integration commit
`14aa19f` and UI follow-up `0439052`, on his separate worktree branch. Those
commits were not on local `dev` at this verification checkpoint; the remaining
Telegram items below need reassessment when that branch is integrated.

## Remaining high-priority work

1. Durable notification outbox, atomic cooldown reservation and replay after
   process failure; sending then logging is not a durable delivery contract.
2. Exclude disabled users from background notification recipients; reconcile
   this with the new Telegram recipient selection rather than patching obsolete
   per-user-rule behavior twice.
3. Integrate and verify Claude's Stage 2 §11 Telegram implementation, including
   account binding, per-favorite preferences, limits, timeouts and retry-after
   handling. Avoid treating these as absent from his unmerged feature branch.
4. Reconcile real alert payloads (`values.actionKind`, `values.notionalUsd`) with
   UI and fixtures, and type/version the payload contract.
5. Clear/cancel private queries on identity changes and scope query keys by user.
6. Inbound API rate limits, monitored-address quotas and bounded/cancellable
   upstream queues. The external API budgeter is not an inbound abuse limit.
7. Dependency audit remediation: initial scan reported 8 high, 15 moderate and
   4 low. Drizzle 0.36.4 is below the identifier escaping patch (0.45.2); no
   untrusted dynamic identifier path was found in this review. Other findings
   include development tools and indirect Privy dependencies; assess reachability
   before equating a package advisory with an exploitable public endpoint.

## Reliability and maintenance follow-up

- Graceful shutdown and explicit pool lifecycle; separate readiness from the
  public in-memory heartbeat used by Railway today.
- Prevent overlapping snapshot/sweep schedules and cap concurrency; expose
  last successful completion, not only last attempted processing.
- Batch/reuse round-trip analytics, especially across notification recipients;
  avoid whole-history scans and unbounded IN bind lists. Measure index needs
  for actions by address and alerts by recipient/cooldown using real query plans.
- Runtime response validation / explicit JSON wire types instead of `as T` and
  Date-typed values that are actually strings after transport.
- Minimal production Docker dependencies, runtime hardening and migration
  deployment sequencing; the current image still contains development packages.
- Repo CI with disposable DB, contract tests and browser E2E tests covering real
  payloads, login/logout/account switching and cross-address isolation.
- Central startup config validation, security headers/CORS policy and import
  row semantic validation (valid Ethereum address, positive rank, size limits).
- Toolchain alignment (TypeScript 5/6, Node type versions); remove unused CLI
  dependencies and evaluate Vite native tsconfig paths support.
- Complete radio/tab keyboard semantics and browser accessibility review.
- Record and verify actual backup/restore and retention settings; PRD prose is
  not proof these operations run. Keep historical PDFs explicitly versioned or
  generate them from Markdown.
- R4–R9, alert scoring and episodes need explicit accepted/deferred status;
  current stubs should not be presented as completed Stage 1 features.

## Verification

An independent temporary local PostgreSQL cluster was used, never the application's
DB. Baseline: 28 files / 294 tests. After regression fixes: 29 files / 315 tests.
Final branch verification and integration results are recorded in the implementation
ledger under `docs/superpowers/plans/2026-09-29-audit-fixes.md`.
