# Admin settings update protocol

`GET /admin/settings` returns the four settings sections plus `revisions` (an
opaque token for each section) and `invalidSections`. Admin reads bypass the
per-process settings cache. GET and PATCH retain the default
HTTP envelope described in [http-contract.md](http-contract.md).

Send only changed fields and the revision last read for every touched section:

```json
{
  "general": { "signupsOpen": false },
  "expectedRevisions": { "general": "<64-character token from GET>" }
}
```

- Missing precondition: 428, `settings_precondition_required`.
- Changed section: 409, `settings_conflict`; none of the requested sections or
  successful-change audit events are written.
- Unknown keys (including announcement/text), empty requests/sections, or invalid
  values: 400. Announcement remains one complete nested value when changed.
- Success returns a fresh snapshot. Only touched sections receive writes. Updating
  one section does not invalidate an untouched section's token.

All preconditions are checked under the existing PostgreSQL transaction advisory
lock, before writes and the audit event. Tokens hash canonical stored JSON and
updatedAt; absent rows have a stable initial token. They are representation
preconditions, not monotonic event IDs, authorization credentials or immutable
historical policy versions. Trusted internal SettingsService callers may omit
preconditions; all AdminSettingsService mutations require them.

The UI retains a dirty section's baseline and draft when another section saves or
a query refreshes. On conflict it keeps the draft and offers an explicit reload
that discards only that section's draft. It does not automatically merge conflicts
or show a field-by-field diff. Saving disables editing in that section until the
request resolves.

## Damaged stored data

An absent row uses bootstrap defaults. An existing malformed row is recovered per
field, preserving valid fields. Missing/malformed signupsOpen, copyTradingEnabled
and alertsEnabled are false; unrelated invalid values use their schema defaults.
The admin response lists damaged sections and the UI displays a repair notice.
Reads do not silently rewrite the database. An explicit valid section patch saves
the recovered section, clearing its diagnostic. Logs include section names only.
Notifications use the same recovery helper for fresh delivery authorization reads,
including queued messages and retries. This does not revoke a send already in flight.

## Rollout and remaining work

Deploy the API and browser changes together. Existing clients without revision
preconditions can read settings but must be upgraded/reloaded before saving (428).
The new browser requires snapshot metadata and cannot operate against an old API.
No schema migration is required for this batch. No production settings are changed
by deploying the code.

Builder snapshot scheduling remains a post-commit best-effort effect.
Acknowledgement of a change by each consumer, finer permissions and real copy
execution remain tracked in [the review](copy-execution-and-admin-review.md).

## When a save takes effect (review finding 16)

A save applies in every process, api and worker, as soon as it commits:

- `SettingsService.patch` sends `pg_notify('orbie_settings', <origin>)` inside
  the saving transaction. PostgreSQL delivers it at commit and not at all on a
  rollback. The saving process drops its own cache right after the commit.
- Every process holds one `LISTEN orbie_settings` connection
  (`SettingsRelay`, in the global `SettingsModule`, any `APP_ROLE`) and drops
  its cached snapshot when the notification arrives. The next read loads the
  rows. In `test/settings-relay.spec.ts` a second pool sees the change in well
  under a second.
- The notification is a hint, never the data. While a process's listening
  connection is down it caches nothing (every read goes to the database) and
  reconnects every second; on reconnect the cache is dropped once more. The
  30-second TTL stays as a bound in case a notification is ever lost.

What that covers: `general.signupsOpen` (checked by `AuthService` when a new
Privy user first signs in), `notifications.alertsEnabled` (checked by
`RulesService` when an action is evaluated, and again uncached by
`NotifyService` before each delivery), `general.maintenance` (below), the
public `GET /settings`, and every other settings field.

`general.copyTradingEnabled` (default off) decides whether a NEW copy may start
(Paul, 2026-10-02). Off: `POST /me/copy/strategies` answers 403
`copy_not_open` and creates nothing, and the trader page's copy panel, which
reads the switch from `GET /settings`, disables its call to action with the
existing "copy trading is not open" wording. Copies already running are not
touched: they keep following their leader and can be paused, resumed, edited
and stopped. Stopping those is what the stop commands on `/admin/copy`
([admin-copy.md](admin-copy.md)) are for; they are read from their rows inside
the transaction that creates an order and again before submission, with no
cache at all. `COPY_TRADING_MODE` is the deployment's capability, not a setting.
The switch must be turned on in each environment before copying is offered.

The browser reads `GET /settings` once a minute and when the tab regains focus,
so what a visitor sees (announcement, maintenance notice) follows a save by at
most that long; the api's enforcement does not wait for the browser.

Known minor UI limitation: simultaneous saves of different sections can return
snapshots out of order and temporarily show older values in clean sections. Dirty
drafts keep their baseline and stale writes are still rejected by server revisions;
merging only the saved section into the query cache is deferred.

## Maintenance mode (review finding 17)

`general.maintenance` is `{ enabled, message: { "zh-TW", en }, endsAt }`
(default off, empty message, no end). It is patched as one whole value, like
the announcement. No migration: it lives in the `general` jsonb row.

While `enabled`:

- **The api refuses writes.** `MaintenanceGuard` (global, after `AuthGuard`)
  answers every request that is not GET / HEAD / OPTIONS with 503 and error
  code `maintenance`, before the handler runs. `Retry-After` is sent while
  `endsAt` is still ahead (seconds, at most a day).
- **Exempt:** a caller with `admin.access` (an admin, or a service token
  granted it), so admins can keep working and can switch maintenance off, and
  everything under `/health`.
- **Reads keep working**, for everyone.
- **The web shows a notice on every page** (`MaintenanceBanner`, above the
  announcement, not dismissible): the admin's text in the page's language
  (zh-TW for zh-TW, the English text for the other ten), or the catalog's own
  wording when the text is empty, plus the expected end while it is ahead.
  The banner comes from `GET /settings`, re-read every minute, on focus, and
  at once when a write is refused with `maintenance`.

`endsAt` is information for visitors. Nothing switches off at that time:
writes stay refused until an admin turns maintenance off.

It takes effect in every api process as soon as it is saved (the mechanism
above; `test/maintenance.spec.ts` switches it on from a second pool and the
app refuses the next write within a second). The save is a `settings.update`
audit event with the old and new `general` section. In `/admin/settings` the
toggle is in the General card; saving a change of `enabled` asks for
confirmation first.

Not covered: the worker's own writes (ingest, copy execution, alert
deliveries) continue; stop those with the copy stop commands and
`alertsEnabled`. A first sign-in creates its user row on a read and is not
refused either; close sign-ups (`signupsOpen`) alongside if that matters.

## Product limits and deployment switches (review findings 18, 19)

`general.maxFavoritesPerUser` (1–10,000, default `null`) is how many traders a
user may keep as favorites. `null` means it is not set here and the
deployment's `MAX_FAVORITES_PER_USER` (default 100) applies; a number wins over
the environment, at once. Lowering it removes nothing; it only stops additions
(409 `favorite_limit` with the limit in force). The General card has the input;
empty saves `null`.

The Discovery card now has inputs for the three weight caps that could only be
set through the API: `poolPerformanceWeightPerMinute`,
`historyWeightPerMinute` and `backfillWeightPerMinute` (0–600 each; 0 pauses
that work).

Some things are deliberately not settings. They are read from each process's
environment at start and shown, read-only, on `/admin/system` ("Deployment
switches"), the api's next to the worker's because the two are separate
processes: `APP_ROLE`, `COPY_TRADING_MODE`, `HYPERLIQUID_NETWORK`,
`TELEGRAM_DRY_RUN`, whether the S3 archive ingest is enabled and its
`S3_ARCHIVE_MAX_DAILY_USD`, and the `MAX_FAVORITES_PER_USER` default. Below
them: the archive ingest's state (not enabled, running, today's cap reached,
last run failed, unknown) with today's spend (UTC) against the cap, its lag and
last run, from the worker's heartbeat. The values come from
`GET /admin/system/overview` (`api.switches`, `worker.sample.switches`); no URL,
bucket, key or token is included. A worker that predates this reports no
switches and the column says "not reported".

## Discovery pool settings and the KOL registry (Stage 3)

`discovery` gained these fields: `candidatePoolSize` (default 1,000: the
official leaderboard's top N by all-time PnL among non-vault accounts with
30-day volume, plus every KOL), `poolPerformanceWeightPerMinute` (default
240: the Hyperliquid weight the pool's performance loop — one `portfolio`
read per row for PnL, ROI, Sharpe, drawdown, copy score and sparklines —
may spend per minute; rows on the boards, home rows, KOLs and followed
traders are read four times as often as the rest), `poolWeightPerMinute`
(default 100: the pool's trade-ledger loop — cold builds and incremental
refreshes; 0 pauses it), `historyWeightPerMinute` and
`backfillWeightPerMinute` (default 120 each: caps the budgeter enforces on
the durable fill-history job and the backward fill backfill), `cohortWeightPerMinute`
(default 60), and `cryptoBoards` / `stockBoards` (the explore tabs and home market tiles,
Hyperliquid coin names such as `BTC` or `xyz:TSLA`). `homeMarkets` now
lists the home page's per-market rows. The board lists are public in
`GET /settings`.

The KOL registry (`kol_traders`) is managed under `/admin/kols` with the
`kols.manage` permission: list, add or replace by address, edit, remove,
and CSV import (`address, display_name, x_handle, verified, sort_order[,
avatar_url]`; `x_handle` may be a handle, `@handle` or an x.com URL).
Invalid rows are reported with their line and skipped; `replace` removes
KOLs the file doesn't list, only when every row is valid. Every change
writes an admin audit event (`kol.upsert`, `kol.delete`, `kol.import`) in
the same transaction. Avatars are cached by the api (`kol_avatars`) and
served from `GET /kols/:address/avatar`; pages never load a third-party
image. A drip job fetches one picture every 30 s: the explicit https URL,
else the 𝕏 profile picture by handle through unavatar.io (anonymous quota
25 a day per IP; a 429 pauses it for its Retry-After) and, while unavatar
is paused, fxtwitter's public profile API (the pbs.twimg.com 400×400
picture). Bytes must be PNG, JPEG, GIF or WebP (never SVG) and at most
512 KB; they are refreshed weekly, and a failed refresh keeps the old
picture. Until a picture is cached the boards return `avatarUrl: null` and
the web draws the generated avatar (also its fallback when the image
fails). Orbie never fetches from CopyDog's hosts: an avatar URL on
`copydog.xyz` is ignored in favour of the handle.

**Seed.** `apps/api/data/kol/copydog-kol-2026-09-30.csv` is CopyDog's KOL
list: `GET https://api.copydog.xyz/api/hyperliquid/discover/tagged`,
fetched 2026-09-30, 168 entries, in CopyDog's order (`sort_order` 1–168),
label as display name (an address used as a label is left blank), the
x.com URL reduced to a handle, CopyDog's `verified` flag; avatars are not
copied. Load it with the same import path the admin uses:

```sh
pnpm --filter @trading-dashboard/api build
DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api kols:seed            # upsert
DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api kols:seed -- --replace  # also drop unlisted
```

Re-running is idempotent. Admins can edit or re-import afterwards; the pool
picks registry changes up within 10 minutes.
