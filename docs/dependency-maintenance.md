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

`pnpm audit --json` changed from 8 high / 15 moderate / 4 low to **0 high /
4 moderate / 0 low**. These are affected package instances, not four distinct
exploitable application routes. Remaining advisories are explicitly unresolved:

| Package/path | Assessment and next action |
| --- | --- |
| esbuild 0.18, via Kit's legacy esm loader | Development server CORS advisory. We use schema generation/migration, not esbuild serve; keep tools off public interfaces. Await loader removal or verify a targeted replacement before overriding a pre-1.0 API. |
| uuid 8/9 via Privy → x402 → wallet connectors | Buffer bounds issue in v3/v5/v6, not v4. Live wallet flows were not audited end-to-end. Await compatible upstream updates; a forced major upgrade is not evidence of compatibility. |
| decode-uri-component 0.2 via legacy WalletConnect query-string | Malformed URI decoding DoS. Remains in a runtime dependency tree; do not label this harmless. Track upstream connector upgrade and test real wallet linking before replacing CommonJS with the fixed 0.5 ESM package. |

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
