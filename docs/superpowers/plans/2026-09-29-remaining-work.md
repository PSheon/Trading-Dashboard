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
