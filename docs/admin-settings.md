# Admin settings update protocol

`GET /admin/settings` returns the four settings sections plus `revisions` (an
opaque token for each section) and `invalidSections`. Admin reads bypass the
30-second business settings cache. GET and PATCH retain the default
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

Business/public reads still cache for up to 30 seconds per process; public browser
settings still lack polling. These are not a live trading kill-switch guarantee.
Builder snapshot scheduling remains a post-commit best-effort effect. Immutable
policy history, distributed invalidation/acknowledgement, finer permissions and
real copy execution remain tracked in [the review](copy-execution-and-admin-review.md).

Known minor UI limitation: simultaneous saves of different sections can return
snapshots out of order and temporarily show older values in clean sections. Dirty
drafts keep their baseline and stale writes are still rejected by server revisions;
merging only the saved section into the query cache is deferred.

## Discovery pool settings and the KOL registry (Stage 3)

`discovery` gained four fields: `candidatePoolSize` (default 1,000: the
official leaderboard's top N by all-time PnL among non-vault accounts with
30-day volume, plus every KOL), `poolWeightPerMinute` (default 240: the
Hyperliquid weight the pool refresh may spend per minute; 0 pauses it),
and `cryptoBoards` / `stockBoards` (the explore tabs and home market tiles,
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
