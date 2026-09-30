# Administrative mutation audit

Migration 0009 adds admin_audit_logs. Apply migrations before deploying this API;
only the isolated local test DB has been migrated during this implementation.

Successful user role/disable edits, self-service account deletions (`user.delete`, counts only; see account-deletion.md), settings patches, rule creates/updates,
leader edits, list imports, copy stop/resume commands at platform or user level
(`copy.control`, target `platform:0` / `user:<id>`, with command, reason and
revisions) and copy risk-policy versions (`copy.risk`, target `policy:<version>`)
record an event in the same transaction as their
business writes. An audit insert failure rolls back the business change. A
rejected operation leaves no successful-change record. Authentication failures
and denied attempts belong to request/security logs, not this success ledger.

Events include timestamp, event, target, actor kind (user/service/system), local
actor ID when applicable, and before/after policy data. User edits contain only
role/disabled flags. Settings contain only requested sections. Rules and leader
edits retain their policy values; free-form notes must not contain secrets.
Imports record list ID, source and counts; the imported list itself holds items.
No raw request headers, bearer tokens, environment secrets or uploaded files are
copied into audit records. System callers are distinguishable from the scoped
service identity. Historical actor IDs survive deletion because they are not a
cascading foreign key.

There is no public audit endpoint. Operators with authorized DB access can query
by created_at, actor_user_id, event or target. Restrict application DB privileges
and backup access appropriately. The application only appends; this is not a
cryptographically tamper-proof ledger against a database administrator.
Retention policy and off-site archival require an operator decision; records are
not automatically deleted by this change.
