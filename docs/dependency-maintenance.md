# Dependency maintenance (2026-09-29)

Use Node 22 (`.nvmrc`) and pnpm 10.17.1 from packageManager; CI uses the
same major and frozen lockfile. API currently compiles with TypeScript 6;
shared/web with TypeScript 5. Do not force a compiler major across workspaces
without checking Nest and wallet SDK peers. Node typings now use major 22.

This review updates Drizzle ORM 0.36.4 → 0.45.3, Kit 0.28.1 → 0.31.11 and
all ws 8.x instances to 8.22.0. The scoped ws override avoids vulnerable exact
pins in wallet dependencies and should be removed when upstream ranges resolve
safe versions themselves. Drizzle schema generation still builds shared first;
the upgraded generator reports no schema changes. No business DB was migrated.
The unused Nest Cloud deployment CLI and `nest deploy` script were removed;
Railway Docker remains the documented delivery route. Vitest uses Vite's native
tsconfigPaths resolution. shadcn is a build dependency (globals.css imports its
Tailwind stylesheet), so it remains installed in build stages as a devDependency.

`pnpm audit --json` initially improved from 8 high / 15 moderate / 4 low to
0 high / 4 moderate / 0 low. The follow-up now reports **0 known advisories
at every severity** (2026-09-29). This is a lockfile advisory result, not proof
that every dependency or live wallet flow is vulnerability-free.

The additional overrides are scoped to inspected consumer versions:

| Consumer | Change and compatibility evidence |
| --- | --- |
| `@esbuild-kit/core-utils@3.3.2` | Replace esbuild 0.18.20 with 0.25.12, already used by Kit itself. Exercise the actual loader's sync CJS and async ESM TypeScript transforms and source maps; run real schema generation. |
| MetaMask SDK / communication-layer 0.33.1, utils 8.5.0 / 9.3.0 / 11.12.1 | Resolve uuid 11.1.1, which retains CJS and ESM exports. Inspected consumers use v4/validate; smoke tests exercise generation, validation, version, output buffers and rejection of undersized v5 buffers through each consumer's resolution. |
| WalletConnect utils 2.21.0 / 2.21.1 | Remove their unused query-string dependency using pnpm's `'-'` override. All three published CJS/ESM/UMD bundles have no query-string reference and URI parsing uses URLSearchParams. Exercise CJS and ESM URI formatting/parsing, including malformed percent input. The vulnerable decoder is removed from the lockfile rather than replaced by an incompatible ESM-only release. |

`node --test scripts/dependency-compatibility.test.mjs` follows active installed
dependency edges and checks these assumptions. It intentionally requires review
when the pinned consumers disappear. Their existing empty `protocol` parse result
is recorded as baseline behavior, not corrected by a dependency override.
CI runs these checks and rejects moderate-or-higher advisories. No advisory is
ignored. Remove each override when its upstream dependency graph is safe without
it; do not extend the exact version scopes without re-inspecting published code.
WalletConnect 2.22.4 and other consumer versions are not changed by this removal.

Privy React 3.46.0 was the registry's latest release at review time. It declares
Farcaster Solana as an optional peer; webpack warns when it is absent. This app
does not enable Farcaster Solana integration. Installing its new incompatible
major just to silence the warning is deferred. The remaining Solana TypeScript
5 vs auto-resolved TypeScript 6 and legacy React peer warnings also remain
upstream compatibility work; passing fixture UI tests does not prove every
wallet connector works.

Dependabot proposes updates; do not auto-merge major changes. Re-run isolated
API tests, schema generation, web unit/browser tests, types and production
builds for ORM/auth dependency changes. Audit counts are dated, not a continuing
security guarantee. Do not add blanket advisory ignores.

Sources: [Drizzle identifier advisory](https://github.com/advisories/GHSA-gpj5-g38j-94v9),
[esbuild advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99),
[uuid maintainer advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq),
[URI decoder advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
