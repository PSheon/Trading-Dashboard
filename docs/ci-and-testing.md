# CI and isolated tests

GitHub Actions CI runs on pull requests and pushes to dev/main with read-only
repository permissions, fixed action commit SHAs and a 30-minute job limit.
It installs the lockfile, blocks moderate/high/critical dependency advisories, runs
`node --test scripts/dependency-compatibility.test.mjs` for scoped overrides, checks
migration schema freshness, checks all workspace types/lints, verifies generated
HTTP docs, migrates a disposable PostgreSQL database, runs API/web tests and
builds production artifacts. Dependabot tracks npm and action updates.
No production secrets, push or deployment step is included. The workflow has
been authored and its component commands tested locally; no remote CI run has
been triggered by this work.

Root `pnpm test` now creates a fresh database for the API run, then runs web
unit tests. `pnpm test:api:isolated [vitest filters]` runs only the isolated API
suite. Set TEST_DATABASE_ADMIN_URL explicitly to a disposable local PostgreSQL
server's postgres database (or a local database ending in _test). The role needs
CREATE DATABASE privileges. The script never reads DATABASE_URL as its parent.
Existing TEST_DATABASE_URL is accepted only as an explicitly validated local
_test parent for compatibility.

Each run uses an unpredictable orbie_<uuid>_test name, applies real migrations
with Drizzle's migrator, passes only that database URL to the suite and drops
only the database it successfully created. Cleanup runs on test failures and
SIGINT/SIGTERM; SIGKILL/power loss can leave the printed database name for an
operator to inspect. Never bulk-delete _test databases: another agent may own
one. Child processes receive forwarded termination signals as a process group.

Spec files remain sequential within a run because they share that run's DB;
separate runs/worktrees have independent databases and may execute concurrently.
The low-level API `test` script remains available for explicitly managed test
DBs and still rejects non-loopback/non-test URLs. No business DB is migrated or
truncated by the isolated runner.

`pnpm test:bootstrap` builds the actual API and checks readiness 200/503 plus
graceful termination using another disposable DB. `pnpm --filter
@trading-dashboard/web exec playwright install chromium` installs the browser;
`pnpm --filter @trading-dashboard/web test:e2e` starts a dedicated loopback
fixture server with an isolated .next-e2e build directory. The server refuses to
reuse an occupied port (default 3109, configurable with PLAYWRIGHT_PORT) unless
PLAYWRIGHT_REUSE_SERVER=1 is set, which is for iterating on one spec against a
fixture server you started yourself; CI never sets it.
Tests cover anonymous admin denial, demo login/logout and public trader
navigation. These do not exercise live Privy login. Test-mode API and frontend
bootstraps do not read repository .env files.

Spec conventions live in `apps/web/e2e/helpers.ts`: `signIn` (the top-bar demo
login on desktop, the page's own prompt on a phone, which has no top bar),
`openFirstTrader` (the visible trader link, then the route change) and `wcag`
(an axe scan with transitions off, so a button mid-fade is not read as a
contrast failure). Favorite group tags are excluded from the contrast scan:
they are tinted with the group's own colour and the 11px blue one reads 4.2:1.

The web typecheck includes `.next-e2e/dev/types`. After a page is removed, a
`.next-e2e` left by an earlier browser run still points at it and typecheck
fails locally (never in CI, which starts clean): delete `apps/web/.next-e2e`.

## Pre-push hook

`scripts/pre-push.sh` runs the checks that most often turn CI red: generated
HTTP contract docs (`http-contract-docs.mjs --check`, `openapi.mjs --check`),
`pnpm typecheck` and `pnpm lint`. About ten seconds when Turborepo's cache is
warm. Install it once per clone (Git does not version `.git/hooks`):

```bash
ln -s ../../scripts/pre-push.sh .git/hooks/pre-push
```

`git push --no-verify` skips it for one push. It builds the api first (cached
when the source is unchanged) because the OpenAPI check reads `apps/api/dist`.

## Running the CI steps locally

The same commands as `.github/workflows/ci.yml`, in order. The database steps
need `TEST_DATABASE_ADMIN_URL` pointing at a disposable loopback PostgreSQL 16.
`scripts/backup-restore-smoke.mjs` needs pg_dump/pg_restore 16 (`PG_DUMP`,
`PG_RESTORE`): a newer pg_dump writes settings a 16 server rejects on restore.
Without local 16 binaries, point both at small wrappers that run the tools
inside the PostgreSQL 16 container with `docker exec` (stream the dump through
stdout/stdin; inside the container the server is 127.0.0.1:5432).
`next build` and a running `next dev` do not collide: dev output is under
`.next/dev`.
