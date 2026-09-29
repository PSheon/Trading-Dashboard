# Admin settings update protocol

`GET /admin/settings` returns the four settings sections plus `revisions` (an
opaque token for each section) and `invalidSections`. Admin reads bypass the
30-second business settings cache. GET and PATCH retain the existing negotiated
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
