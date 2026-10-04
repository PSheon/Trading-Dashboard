# Backend conventions

These conventions apply to new and touched API code. They follow the repository's Nest + Drizzle architecture and borrow DonutMe's explicit bootstrap setup and responsibility-oriented JSDoc. They do not require copying DonutMe's Fastify, TypeORM, Redis or telemetry stack.

## Entrypoint and bootstrap

`apps/api/src/main.ts` owns the executable startup sequence: local environment loading, validation, redacting logger construction, Nest creation, shutdown setup, HTTP setup, environment-gated Swagger, then listen. Validate before constructing clients or starting background work. Importing a setup module must not open a listener or register process signal handlers.

- `bootstrap/http.setup.ts`: trusted proxies, HTTP security, request context and JSON serialization, configured before routes initialize. Tests use the same `setupJsonSerialization` for bigint identifiers.
- `bootstrap/shutdown.setup.ts`: register once in the executable, before Nest signal listeners. Mark jobs stopping synchronously; retain the unref'ed deadline across hooks, HTTP close and pool drain. Do not call it from per-test application factories.
- `bootstrap/swagger.ts`: actual Nest metadata plus wire responses. Keep production/staging docs disabled and dynamic loading conditional.
- Global guards, pipes, interceptors and filters remain DI-managed module providers. Do not register duplicate instances in bootstrap or silently change their order during cleanup.

Use named, typed setup functions for distinct responsibilities. Keep startup ordering visible in main; avoid a generic bootstrap framework or a new file for every trivial statement.

## Modules, services and repositories

Feature modules own their service/repository registrations. Export only providers consumed outside the feature. Services own policy, HTTP/domain outcomes and use-case sequencing; repositories own queries and persistence. A transaction-spanning use case owns UnitOfWork and passes the same transaction to every participating repository. Repositories must not silently use their root client inside such operations.

Name files in kebab-case with the existing role suffix (`.service.ts`, `.repository.ts`, `.module.ts`, `.setup.ts`). Preserve explicit `.js` extensions for local ESM imports. Use type-only imports where appropriate. Group Node imports, external packages, then local modules; prefer double quotes as in most API files. Format touched code readably without creating unrelated whole-repository formatting diffs. These are review conventions, not claims that a formatter currently enforces all of them.

## JSDoc and comments

Use English comments to match the existing backend. Document exported setup functions, service/repository responsibilities and non-obvious public method contracts. Explain ownership, caller preconditions, transaction/lock requirements, cache freshness, idempotency and meaningful missing-result semantics. Use `@param`, `@returns`, `@throws` or `{@link ...}` when they add information beyond TypeScript signatures; do not repeat every parameter type or narrate obvious getters.

For example, a claim method should explain that `undefined` means another worker may have won. A failure update should explain the claim generation that prevents stale writes. A transaction helper should identify the lock that must already be held. Do not describe a runtime guarantee stronger than the code provides, such as exactly-once external delivery.

Inline comments explain why a local statement exists. Remove stale phase labels and update comments with behavior changes. Never include secrets, raw tokens or personal data as examples.

## Validation and review

For behavior changes, add regression coverage at the observable boundary. Preserve real PostgreSQL coverage for locking, rollback and concurrent writes. For behavior-preserving setup extraction, run existing HTTP tests and the compiled bootstrap smoke test; typecheck alone cannot prove wiring or middleware order. Avoid tests that merely mirror formatting or require a comment on every method.

Keep current contract/architecture documentation and the execution ledger in sync. All current services keep direct Drizzle access behind repositories. The recursive `test/repository-boundary.spec.ts` gate covers every `.service.ts`, including future additions. It rejects ORM/schema imports and direct client/transaction queries; it is a source-level guard, not proof of domain correctness or cross-instance coordination. Shared persistence helpers and database infrastructure may still use Drizzle. Review transaction ownership and behavior with integration tests.

## Indexes on large tables

`scripts/migrate.mjs` runs Drizzle's migrator, which applies every pending migration in one transaction with `lock_timeout` 15 s. A plain `CREATE INDEX` holds a write lock on its table for the whole build, so on a large table (`history_fills`, `analysis_history_fills_retired`, `fills`, `trader_stats`, `position_snapshots`, `actions`, `trader_trades`, `equity_snapshots`, `history_accounts`) it either stops the worker's writes for minutes or fails the release. PostgreSQL refuses `CREATE INDEX CONCURRENTLY` inside a transaction, so it cannot go in a migration file either. For a new index on one of these tables:

1. Generate the migration with drizzle-kit as usual, then edit the generated statement to `CREATE INDEX IF NOT EXISTS …` (same name, same definition). Editing is fine before the file is applied anywhere; never edit an applied migration (`0000`–`0060` are applied).
2. Before the release, build the index with the same name and definition outside any transaction, on Stage first and then production: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "<name>" ON "<table>" …;`
3. Check it is valid: `SELECT indisvalid FROM pg_index WHERE indexrelid = '"<name>"'::regclass;`. A failed or cancelled concurrent build leaves an invalid index that `IF NOT EXISTS` would skip; drop it (`DROP INDEX CONCURRENTLY "<name>"`) and build again.
4. Deploy. The migration's `IF NOT EXISTS` finds the index and returns at once. On a fresh or small database (tests, local) it simply builds it.

`apps/api/scripts/migrate.test.mjs` fails CI when a migration after `0060` adds an index on one of these tables without `IF NOT EXISTS`, or uses `CONCURRENTLY` inside a migration. Add a table to its `LARGE_TABLES` list when it grows past a few hundred MB.
