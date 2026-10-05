# CI and isolated tests

GitHub Actions CI (`.github/workflows/ci.yml`) runs on pull requests and pushes
to dev/main with read-only repository permissions and fixed action commit SHAs.
No production secrets, push or deployment step is included. Dependabot tracks
npm and action updates. A newer push to the same ref cancels the run in progress.

## Job graph

```
changes ─┬─ checks                 lint, typecheck, doc checks, script + web unit tests
         ├─ api (1/4) … api (4/4)  the api suite, one PostgreSQL each
         ├─ smokes                 release migration + backup/restore smokes
         ├─ build                  pnpm build, compiled api bootstrap, docker image smoke
         └─ browser (1/3) … (3/3)  Playwright, one fixture server each
                                   └──────── all of them ──────── ci
```

| Job | Runs when | Steps |
| --- | --- | --- |
| `changes` | always | decides the groups below (`scripts/ci-changes.mjs`) |
| `checks` | always | docs-only: api build + HTTP contract/OpenAPI checks. Otherwise also dependency override tests, `pnpm audit`, migration schema freshness, typecheck, lint, script tests, web unit tests |
| `api (n/4)` | `api` | `pnpm test:api:isolated --shard=n/4` |
| `smokes` | `api` | `migration-smoke.mjs`, `backup-restore-smoke.mjs` (pg_dump/pg_restore 16) |
| `build` | `code` | `pnpm build`, `bootstrap-smoke.mjs`, `docker build`, `image-smoke.mjs` |
| `browser (n/3)` | `web` | `test:e2e --test-list` of the shard's specs (`scripts/test-shards.mjs`); a fixture server that fails to start (an intermittent Turbopack next/font/google error) is started once more, a failed test never; traces and screenshots of failures are uploaded as `playwright-results-n` |
| `ci` | always | fails if any job above failed or was cancelled; skipped is fine |

**Branch protection targets `ci`** (one stable name, whatever ran). Job
timeouts: `changes`/`ci` 5 min, `smokes` 10, the rest 15.

## What runs when

`scripts/ci-changes.mjs` (tests: `scripts/ci-changes.test.mjs`) maps each
changed file to groups:

| Changed path | api | web |
| --- | --- | --- |
| `docs/content/**` (the web pages' copy, checked by the web unit tests) | – | ✓ |
| the rest of `docs/**`, root `*.md` | – | – |
| `apps/api/**`, `scripts/**` | ✓ | – |
| `apps/web/**` | – | ✓ |
| `packages/shared/**` | ✓ | ✓ |
| anything else: `pnpm-lock.yaml`, `.github/**`, root configs, `patches/**`, new top-level paths | ✓ | ✓ |

`code` is api or web: any change outside the docs. So a docs-only push runs
`changes`, the doc checks in `checks` and `ci`; a web-only push skips the api
shards and the smokes; an api-only push skips the browser shards.

What the diff is taken against:

- pull request: its base commit (merge base).
- push: the head of the branch's **last successful CI run**, not just
  `before`. If a run was cancelled by a newer push or went red, the next run
  still sees its changes, so a docs commit on top of an untested api change
  runs the api tests.
- Everything runs when unsure: `before` is the zero SHA (new branch), a force
  push, no green run to compare with, a base that is not an ancestor of HEAD,
  an empty diff (a re-run), any other event, or an error in the script.

## Caches

`.github/actions/setup` installs pnpm, Node 22 with setup-node's pnpm store
cache, and runs `pnpm install --frozen-lockfile`. `checks` and `build` also
restore and save Turborepo's local cache (`.turbo/cache`, per job, newest entry
first) so an unchanged package's build, typecheck and lint replay instead of
rerunning; `TURBO_CACHE_MAX_SIZE=1GB` bounds it.

## Shards

Both suites are split by file, balanced by each file's run time in an earlier
CI run, not by file count: `apps/api/test/shard-durations.json` and
`apps/web/e2e/shard-durations.json`. `scripts/test-shards.mjs` puts the longest
files first, each onto the shard with the least time so far; a file with no
recorded time counts as the median one. Every file is in exactly one shard
whatever the durations say, so stale times only cost balance.

- api: `apps/api/vitest.config.ts` replaces Vitest's `--shard` split (a hash of
  each path, an equal file count, which ran 235–352 s per shard) with that one.
  `scripts/test-api-isolated.mjs` passes `--shard` through
  (`scripts/api-test-files.test.mjs`); each shard creates its own database.
- browser: `node scripts/test-shards.mjs e2e n/3` prints the shard's specs and
  Playwright runs them with `--test-list` (Playwright's own `--shard` splits
  contiguous runs of files by test count, 190–387 s per shard).

Run one shard locally the same way:

```bash
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm test:api:isolated --shard=2/4
node scripts/test-shards.mjs e2e 2/3 > /tmp/e2e-shard.txt
pnpm --filter @trading-dashboard/web test:e2e --test-list /tmp/e2e-shard.txt
```

Refresh the times when the shards drift apart (the api shards print each file's
time, the browser shards use the list reporter):

```bash
for job in $(gh run view <run-id> --json jobs --jq '.jobs[] | select(.name | test("^(api|browser) ")) | .databaseId'); do
  gh run view --job "$job" --log > "/tmp/shard-$job.log"; done
node scripts/test-shards.mjs refresh /tmp/shard-*.log
```

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

The same commands as the jobs in `.github/workflows/ci.yml`. The database steps
need `TEST_DATABASE_ADMIN_URL` pointing at a disposable loopback PostgreSQL 16.
`scripts/backup-restore-smoke.mjs` needs pg_dump/pg_restore 16 (`PG_DUMP`,
`PG_RESTORE`): a newer pg_dump writes settings a 16 server rejects on restore.
Without local 16 binaries, point both at small wrappers that run the tools
inside the PostgreSQL 16 container with `docker exec` (stream the dump through
stdout/stdin; inside the container the server is 127.0.0.1:5432).
`next build` and a running `next dev` do not collide: dev output is under
`.next/dev`.

## Browser suite server

`apps/web/playwright.config.ts` starts one `next dev --turbopack` fixture
server (`NEXT_TEST_MODE=1`, `NEXT_PUBLIC_API_FIXTURES=1`, built into
`.next-e2e`) and compiles every route before the first test
(`e2e/global-setup.ts`). It used `--webpack` until 2026-10-05: webpack keeps
the compiled routes in the server's JavaScript heap, CI's 4 GB filled a few
minutes into the run (run 37210498699) and every later test met a dead
server. Turbopack compiles in native code; the whole suite runs on one
server. `PLAYWRIGHT_BUNDLER=webpack` brings the old server back for a
comparison run, and `PLAYWRIGHT_REUSE_SERVER=1` reuses a fixture server you
already started on `PLAYWRIGHT_PORT` (default 3109) with the same env.

A production (`next build`) fixture server is not used: next.config.ts
refuses fixture mode in any production build or server, on purpose.
