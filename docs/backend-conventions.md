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

Keep current contract/architecture documentation and the execution ledger in sync. A completed feature refactor does not imply all backend modules conform: Notify, Rules, watcher and other legacy services still require incremental review.
