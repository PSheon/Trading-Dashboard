<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Tuning constants

Every tuning constant of the api's live copy path (`*_MS`, `*_LIMIT`, `*_ATTEMPTS`, `*_SHARE`, `*_TTL_MS`, `*_WEIGHT`, `*_CAP`, `*_RESERVE`, `*_FLOOR`) lives in `apps/api/src/config/constants/`, grouped by domain, with no duplicates (one meaning, one name; a value derived from another constant is written as an expression of it). `apps/api/test/tuning-constants.spec.ts` refuses a tuning-named `const` declared elsewhere under `hyperliquid/`, `copy/` or `config/` (unless allow-listed there with a reason), a duplicated name, and a constant without a basis line.

The first comment line of every constant states its basis and source, in this form:

```ts
/** basis: measured — gate 5 (2026-10-13): an account-mode step took up to ~40 s from grant to its last charge
 * (what it means, how it is used)
 */
```

`measured` (a gate, a harness or the provider's docs), `derived` (from another constant, named), `copied` (from another check, with no reason of its own) or `guessed` (a number that looked right). A guessed constant also says how it will be verified (`verify: …`, or `gate N records p50/p99`). Change a guessed value only with the measurement that replaces it, and update the basis line.
