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

The last-admin and self-demotion/disable safeguards remain. Role/disable edits
invalidate authentication cache in the current process. The application remains
single replica; cross-process invalidation, in-flight authorization revocation,
role-change audit events and dynamic custom roles are follow-up work. Frontend
`/me.permissions` and permission-based UI are also deferred; the current UI still
uses its existing user/admin role display. Never rely on UI visibility for access.

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

SIGTERM/SIGINT stop new work, cancel upstream requests and drain tracked jobs.
A 30s watchdog bounds the entire process shutdown; background drain has a 25s
budget and pool close has 3s before remaining connections are closed. Deadline
expiry can interrupt work, so this alone does not guarantee notification delivery.

`GET /admin/outbox` requires `admin.access`; see [delivery recovery](notification-delivery.md).
