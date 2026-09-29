# Backup and restore runbook

The repository now has a repeatable **synthetic local** recovery drill:

```sh
TEST_DATABASE_ADMIN_URL=postgres://test_role@127.0.0.1:5432/postgres \
  node scripts/backup-restore-smoke.mjs
```

Use pg_dump/pg_restore matching the server major (or a supported newer dump
client); PG_DUMP and PG_RESTORE can select executable paths. The script creates
two unpredictable local test DBs, migrates them, inserts synthetic identity,
favorite, action, outbox and audit records, dumps the source, restores only its
owned target, compares every public/drizzle table and index, checks foreign-key
and unique constraints and checks sequence progression. It drops both DBs and
removes its temporary archive on normal completion/failure. No actual customer
backup or restore is performed. A 50,553-byte sample completed in 1.551 seconds;
this is not a production RTO benchmark.

## Production operating procedure (not executed)

1. Assign a backup owner and agree recovery-point and recovery-time objectives.
   Record actual provider backup frequency, retention, encryption, restore
   permissions, location and last successful drill. These facts are currently
   **unverified**; the repo cannot establish Railway account backup settings.
2. Keep provider snapshots/PITR as appropriate to those objectives and an
   encrypted, access-controlled copy outside the primary failure domain.
   Monitor job failure, backup age and storage capacity; alert an operator.
   Choose retention according to actual data/legal needs; no arbitrary production
   retention policy is enacted here.
3. Before release migrations, identify a successful backup and recoverable
   timestamp. Logical dumps include the migration journal, audit and outboxes.
   PostgreSQL role/grant configuration and deployment secrets require their own
   protected recovery inventory; --no-owner/--no-acl in the synthetic drill
   deliberately does not test role/ACL restoration.
4. Restore into a new isolated DB using a trusted archive, validate tables,
   constraints, schema version and role grants, run ANALYZE, then start the
   matching application release with external sends disabled. Do not overwrite
   the only surviving database or test restoration in place.
5. Confirm user ownership, revoked accounts, key queries and readiness. Reconcile
   outbox deliveries before enabling Telegram: events sent after the backup point
   may be replayed; at-least-once delivery can duplicate a message. Historical
   backfill does not reconstruct all lost favorites/settings/audit history.
6. Plan write freeze/traffic switch and rollback with the operator; record the
   chosen recovery point, measured restore duration, verification evidence and
   any lost/replayed events. Resume workers/sends only after reconciliation.

Perform regular restore drills and after schema/storage changes. A green local
smoke verifies tooling and current schema compatibility; it does not prove
production backup existence, PITR, off-site copies, security, RPO or RTO.

References: [PostgreSQL SQL dump](https://www.postgresql.org/docs/15/backup-dump.html),
[pg_restore](https://www.postgresql.org/docs/15/app-pgrestore.html),
[notification delivery](notification-delivery.md), [release migration](container-delivery.md).
