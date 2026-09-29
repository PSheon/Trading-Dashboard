# Audit fixes implementation and verification ledger

Goal: fix confirmed correctness and developer-safety defects in an isolated worktree, preserve Claude's concurrent feature work, and rebase onto current dev.

Base: 3cf7d4c. Branch: codex/audit-fixes. No edits to the primary checkout.

Scope: test database safety; existing API validation/address filtering; snapshot atomicity and flat-position reads; fill-to-action recovery; developer setup, Docker context and current-state documentation. Telegram redesign and activity feature implementation belong to Claude. Larger outbox, rate-limiting, dependency upgrades and frontend authentication changes remain separately tracked audit work rather than being silently bundled into this patch.

## Tasks

- [x] Establish isolated PostgreSQL and full test baseline.
- [x] Test DB: add regression tests for ignoring DATABASE_URL and rejecting non-test/remote targets; implement a dedicated TEST_DATABASE_URL resolver with loopback and test-name restrictions.
- [x] API boundaries: real HTTP/DB regressions for address filters, malformed/oversized limits, invalid imports and protected PATCH fields; parse shared schemas and normalize addresses.
- [x] Snapshots: real DB regression for insert failure rollback and open-to-flat transitions; transactionally persist a snapshot and use equity snapshot timestamps to read positions.
- [x] Fill sync: regression for interrupted action creation and a failed later page; retain successfully stored raw fills and process replayed fills under the existing action lock.
- [x] Development/deployment: exclude secrets/build outputs from Docker context, load migration env explicitly, build shared before dev, set separate web port, account for Turbo env inputs.
- [x] Documentation: replace API starter README; correct root onboarding and fast path description; document historical specs and outstanding audit work.
- [x] Run full tests, typecheck, lint, builds; review changes; commit coherent groups; inspect new Claude commits and rebase onto dev; rerun affected verification.

## Constraints and review focus

- Only the new loopback PostgreSQL cluster on port 55439 is used for destructive tests.
- No Telegram delivery, real trading, production DB access, pushes or forced updates.
- Preserve fill deduplication and fast-path correction semantics; avoid duplicate alerts on replay.
- Empty position snapshots must mean flat, not missing data; failed writes must leave no partial snapshot.
- Validation must preserve legitimate existing query formats and return 400 for malformed data.
- Recheck dev commits before integration; do not update an actively edited primary worktree.

## Results

- Baseline: 28 test files / 294 tests passed on the isolated PostgreSQL cluster.
- Final root `pnpm test`: 29 files / 315 tests passed, including failure/retry recovery, atomic snapshot rollback, HTTP validation and 7,000-action replay.
- API/shared/web typecheck, API/web lint, API build and Next production build passed.
- Migration loading from a temporary root `.env` passed against the isolated test DB; missing DATABASE_URL fails connection commands; offline schema generation succeeded without schema changes.
- Turbo dev dry-run confirmed shared build dependencies and separated web/API ports; `git diff --check` passed.
- Independent review found N sequential fill reads under the action lock and repeated health-counter increments during replay. Both were corrected, regression-tested and reviewed again with no remaining important findings.
- Claude commits inspected: activity already on dev at `3cf7d4c`; Telegram `38ce99e` / `14aa19f` and UI `0439052` remain on his separate branch at this checkpoint.
- Integration target: local `dev`; rebase first, then fast-forward only after confirming the primary checkout is clean. No remote push or feature-branch merge from Claude is included.
- This is the first correctness/safety batch. The remaining audit backlog is tracked in `docs/audit-follow-up.md`; no claim is made that every audit finding is fixed.
