# Authentication, authorization and startup configuration

## Identity and permissions

Privy verifies the bearer token and supplies the stable Privy DID. Local `users`
records own role (`user`/`admin`) and disabled status. Email and wallet addresses
are profile attributes, not authorization identifiers. Privy metadata does not
supply application permissions.

`AuthGuard` runs before `PermissionGuard`. Legacy `@Roles` applies only to human
users. `@RequirePermissions` requires every declared permission and overrides
`@Public`; method permission metadata replaces a class default. Each admin
handler declares its own permission. `admin.access` is a fail-closed class
default for future admin handlers; granting it alone grants none of today's
administrative operations.

| Action | Permission |
| --- | --- |
| GET /admin/overview | overview.read |
| GET /admin/revenue | revenue.read |
| GET /admin/settings | settings.read |
| PATCH /admin/settings | settings.write |
| GET /admin/users | users.read |
| PATCH /admin/users/:id | users.manage |
| GET /lists and /lists/diff | lists.read |
| POST /import/lists | leaders.import |
| PATCH /leaders/:chain/:address | leaders.manage |
| GET /alert-rules | rules.read |
| POST /alert-rules | rules.manage |
| Read all users' alerts (including legacy leader detail) | alerts.readAll |

Human admins receive the catalog in `packages/shared/src/permissions.ts`.
Ordinary users receive no administrative permissions; their authenticated `/me`
and favorite/Telegram routes continue to enforce user ownership separately.
Permission checks never replace ownership checks. Disabled users cannot access
protected routes. Public browsing retains its anonymous fallback.

Service tokens authenticate a distinct principal with only the comma-separated
`AUTH_SERVICE_PERMISSIONS` grants. Omitted/empty grants mean **no administrative
access**. Wildcards and unknown names are rejected. Service callers cannot use
human-only `/me` resources or satisfy legacy human `@Roles`. Without
`alerts.readAll`, their alert queries return no private rows.

## Migration from implicit service admin and recurring bootstrap

Before deployment, inventory each server integration using AUTH_SERVICE_TOKEN
and assign only its needed permissions. For example:

```dotenv
AUTH_SERVICE_PERMISSIONS=lists.read,leaders.import
```

Existing Privy admins retain their role and permissions. No schema migration or
Privy dashboard role setup is needed. The frontend response shapes are unchanged.

AUTH_ADMIN_EMAILS applies only when inserting a **new** user. A demoted existing
account stays demoted even when its email remains on the list. Adding an existing
user's email to that list no longer promotes them. An existing admin must make
that role change through the admin API. A missing profile can be retried later,
but that profile refresh cannot grant admin. When initially onboarding the first
admin, verify the Privy profile lookup succeeds; if an account was already
created as a user, use an explicitly scoped administrative recovery integration
or an operator-controlled database procedure, not recurring email promotion.

The last-admin and self-demotion/disable safeguards remain. Every authenticated
request reads persisted role/disabled state, even when its Privy verification is
cached. A committed change is visible at the next database authorization read
in any application process, and an in-flight profile lookup is followed by a
fresh read before publishing a caller. DB errors fail closed on protected
routes. Requests already authorized before a concurrent commit can finish;
this does not cancel in-flight business operations or revoke a Privy session.
Privy verification itself is cached for at most 30 seconds and never past token
expiry. Workers still use the supported single-replica topology.

GET/PATCH /me returns effective `permissions` from the same role catalog as
API guards. The frontend gates admin routes, navigation and write controls by
permissions, fails closed on missing/failed profile data, and refreshes /me every
30 seconds while active. Its display may lag a role edit until refresh; the API
still checks each request. Deploy the API contract before this frontend version.
Successful administrative mutations are now transactionally audited; see
[administrative audit](admin-audit.md). Dynamic custom roles remain out of scope. Never
rely on UI visibility for access.

## Startup validation

`config/runtime-config.ts::validateEnvironment` runs before Nest creates DB,
watcher or bot providers. It returns typed app/database/auth/telegram/hyperliquid
configuration without connecting to any service. Build/typecheck need no runtime
credentials. The existing runtime readers remain in this batch; a full DI config
migration is separate work.

- NODE_ENV: development/test/staging/production; absent defaults to development.
- PORT: integer 1–65535; default 3000.
- DATABASE_URL: required PostgreSQL URL with host and database name; no fallback.
- Booleans: true/false/1/0 only (case-insensitive, surrounding whitespace ignored).
  Empty or misspelled values fail, especially TELEGRAM_DRY_RUN.
- Integer fields reject partial numbers and fractions. Hyperliquid budget is
  1–1199/minute; configured burst 1–1200 (budgeter still caps effective burst).
  Alert horizon is 1–86400 seconds.
- AUTH_SERVICE_TOKEN: optional; when configured in production/staging it must be
  at least 32 characters and not an obvious placeholder. This checks configuration,
  not cryptographic entropy; generate a random token and rotate it operationally.
  Permissions require a configured token.
- AUTH_ADMIN_EMAILS: comma-separated email addresses; creation-only bootstrap.
- PRIVY_APP_ID / PRIVY_APP_SECRET: set both or neither. An optional verification
  key requires Privy credentials and a valid ES256 public key.
- TELEGRAM_BOT_TOKEN: required for real sending (DRY_RUN=false). A configured bot
  token also requires a valid bot username for the linking flow. With no token,
  dry-run/public-only local development remains supported. Polling defaults true
  but the bot does not start without a token; bot conversation replies are not
  suppressed by alert dry-run.
- STREAM_MAX_PER_IP (1–1000, default 8) and STREAM_MAX_TOTAL (1–100000,
  default 500; not below the per-IP value) bound open `GET /actions/stream`
  connections; STREAM_TRUSTED_PROXY_HOPS (0–10, default 0) says how many
  X-Forwarded-For entries (from the right) were appended by trusted proxies,
  including the web forwarder. Only that entry names the client; anything
  further left is client-supplied and ignored. The header is read only when
  the socket peer is in API_TRUSTED_PROXY_CIDRS; otherwise the peer counts.
- Upstream HTTP/WS URLs and Telegram link URLs must use the expected protocols,
  have a host, and contain no credentials or fragment.

Validation errors name configuration keys, not supplied secret values. Actual
.env files are not modified by code changes. Deployment settings must be updated
explicitly; the committed .env.example only documents defaults.

## Verification boundaries

HTTP tests use actual Nest guards/controllers and PostgreSQL, with Privy and
external messaging stubbed. They exercise permission restrictions, service
scope narrowing, private alert isolation, and persistent manual demotion.
These tests do not prove the remote Privy service or token cryptography; dedicated
SDK integration coverage remains separately tracked.

## Runtime deadlines and health

Deployment readiness uses `/health/ready` (DB probe); `/health` remains the
in-memory feed heartbeat. The pool waits at most 3s for a connection, applies
15s server statement/idle-transaction limits and a 20s driver query timeout.
Browser-facing API work has a 20s overall deadline; a disconnected caller aborts
queued/in-flight Hyperliquid requests. Explicit background work is independent
of the HTTP request that admitted it.

`GET /actions/stream` (server-sent events) is the one exemption from the 20s
deadline: once admitted it calls `releaseRequestDeadline`, and it lives until
the client disconnects (which still aborts the request signal and frees its
slot), a 10s initial setup deadline or 1 MiB per-subscriber queue limit is reached,
favorites authorization fails/expires (checked before delivery and every 15s,
with a 5s check timeout), or shutdown begins. Shutdown ends all streams so the
HTTP server can close; clients reconnect with `Last-Event-ID` and a current token.
See [HTTP boundary](http-contract.md) for validation and revocation limits.

SIGTERM/SIGINT stop new work, cancel upstream requests and drain tracked jobs.
A 30s watchdog bounds the entire process shutdown; background drain has a 25s
budget and pool close has 3s before remaining connections are closed. Deadline
expiry can interrupt work, so this alone does not guarantee notification delivery.

`GET /admin/outbox` requires `admin.access`; see [delivery recovery](notification-delivery.md).

## Privy verification tests

The installed @privy-io/node SDK is exercised through SdkPrivyVerifier using
fresh local P-256 keys and ES256 JWTs. Tests reject incorrect issuer/audience,
expiry/missing claims, wrong signatures, malformed tokens and algorithm
confusion. An actual HTTP guard test ignores role/permission claims and resolves
RBAC from the local users table, including promotion and disable with a cached
verified token. No production credentials or provider login is required.

Pinned-key replacement is tested by constructing a restarted verifier with the
new key. Live Privy login, provider-side revocation and remote JWKS fetching/
rotation are not claimed by these offline tests. The installed SDK configures
remote JWKS cache/refresh behavior when no pinned key is supplied. Reference:
[Privy access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens).

## Content-Security-Policy (web)

`apps/web/src/proxy.ts` sets a per-request CSP (built in `src/lib/csp.ts`):
scripts only by nonce with `'strict-dynamic'` (no `'unsafe-inline'`, and
`'unsafe-eval'` only under `next dev`), `connect-src` limited to the same
origin (the API goes through the `/api/hl` forwarder), Privy
(`auth.privy.io`, `*.rpc.privy.systems`, WalletConnect/walletlink, Cloudflare
Turnstile), Hyperliquid mainnet and testnet (REST and WebSocket), the Arbitrum
One and Sepolia RPCs the embedded wallet uses, and `t.me`; frames only Privy,
WalletConnect verify and Turnstile. The Privy app's custom auth domain
(`privy.stage.orbie.fun` today, where its iframe and API live) is allowed, as
is `privy.orbie.fun`; add others with `NEXT_PRIVY_AUTH_ORIGINS`. A new
browser-side origin must be added to `csp.ts`, or it is blocked.

Owner actions (Privy dashboard, not code):

- **Allowed domains.** Set Privy's `allowed_domains` to the deployed origins
  (`https://app.orbie.fun`, stage, and `http://localhost:3001` for development).
  Privy's own iframe on `privy.stage.orbie.fun` already refuses to be framed
  by any origin but `app.orbie.fun` and `stage.orbie.fun`, so a local build on
  another port can open the login modal but can't finish signing in.
- **HttpOnly cookie sessions.** Privy's cookie sessions need the custom auth
  domain on the same site as the app (e.g. `privy.orbie.fun` for
  `app.orbie.fun`), configured when the production domain is set up; then
  add it to `NEXT_PRIVY_AUTH_ORIGINS` if it isn't one of the built-in ones.

