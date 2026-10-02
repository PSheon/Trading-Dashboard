# Data retention

What the privacy policy (§6) promises, what the worker deletes, and why the
snapshot tables are not partitioned. Review findings 3 and 20; owner's
periods of 2026-10-01.

## Periods

| Data | Table | Default | Setting (`general.retention`) |
| --- | --- | --- | --- |
| Position and equity snapshots | `position_snapshots`, `equity_snapshots` | 90 days | `snapshotDays` (30–3650) |
| Admin audit log | `admin_audit_logs` (every event except `user.delete`) | 1 year | `auditDays` (30–3650) |
| Account-deletion records | `admin_audit_logs` where `event = 'user.delete'` | 1 year | `accountDeletionDays` (30–3650) |
| Finished evaluations | `action_outbox` (`done`, `failed`) | 30 days | `queueDays` (7–3650) |
| Finished deliveries | `notification_outbox` (`sent`, `dry_run`, `failed`) | 30 days | `queueDays` |
| Finished copy signals | `copy_signal_outbox` (`done`, `failed`) | 30 days | `queueDays` |
| Alert delivery records | `alerts` | 30 days | `alertDays` (7–3650) |

Admins edit the periods in **Settings › General › Data retention**; `enabled: false`
stops the job. The defaults are the periods the policy states: changing one
makes the policy untrue until its text is changed too (the form says so).
A save is audited like every settings change.

## The job

`RetentionService` (`apps/api/src/retention`), scheduled by `RetentionWorkerModule`
in the worker (three ticks an hour; none in the api role).

- **Off-peak, once a day.** It runs when the UTC hour is 18–21 (02:00–06:00 in
  Taipei) and the last finished run is more than 20 hours old. A run cut short
  by a deploy is picked up by a later tick of the same window.
- **Bounded.** One `DELETE` removes at most 2,000 rows; at most 250 statements
  per table per run (500,000 rows), a 200 ms pause between statements, 20
  minutes for the whole run. What is left is finished by the next runs; such a
  run is recorded as `partial`. No statement holds a table lock or an open
  transaction across batches.
- **Lease.** `retention_state` (one row) carries `lease_token` and
  `locked_until` (5 minutes, extended after every statement). A second worker
  finds the lease taken and does nothing; if the holder dies, the lease expires
  and the next tick takes it. A worker that lost its lease stops at its next
  statement and records nothing.
- **Reported.** The same row keeps the last run: start, end, status, rows
  removed per table, the cutoffs used, the error if any. `GET /admin/system/overview`
  returns it as `retention` and the System page shows it.
- **Audited.** Each run writes one `retention.run` admin audit entry (actor
  `system`): the settings and cutoffs before, the status and rows removed after.

## What is never removed

- An outbox row that is not finished (`pending`, `processing`).
- A finished evaluation whose action still has a delivery waiting, and a
  finished delivery whose action's evaluation is still open. While one side is
  unfinished the other is what stops the action from being evaluated or sent a
  second time (`notification_outbox` is unique per action and user).
- A copy signal at or above the consumer's checkpoint
  (`copy_consumer_checkpoints.last_outbox_id`).
- An alert record whose delivery is still queued.
- `actions`. Both outboxes reference `actions` with `ON DELETE CASCADE`, so
  deleting an action would take its queue rows with it. The job deletes queue
  rows only, which cascades to nothing: no table references `action_outbox`,
  `notification_outbox`, `copy_signal_outbox` or `alerts`.
- `fills`, `history_fills`, `trader_trades`, copy orders, fills and ledger:
  not in scope (public market data, or the user's own records kept for the life
  of the account).

After a finished queue row is gone, nothing re-creates it: an `action_outbox`
row is written only in the transaction that inserts its action, and a
`copy_signal_outbox` row only in the transaction that inserts its fill.
`copy_signal_legs` (strategy, tid, leg) still dedupes a replayed fill.

## Why the snapshot tables are not partitioned

Measured on the dev database, 2026-10-02 (3.4 days of data, 20 watched leaders):

| Table | Rows | Size | Per day |
| --- | --- | --- | --- |
| `position_snapshots` | 53,058 | 16 MB | 15.6 k rows, 4.7 MB |
| `equity_snapshots` | 14,100 | 5.8 MB | 4.1 k rows, 1.7 MB |

At 90 days that is about 1.4 M rows and 420 MB for positions and 0.37 M rows and
150 MB for equity; at the cap of 100 watched addresses plus the imported
leaders, a few times that. Monthly partitions would let a month be dropped
instead of deleted, which pays off when a delete is slow or bloats the table.
Here it does neither: the daily delete is the oldest day only (about 16 k and
4 k rows), read through `position_snapshots_ts_idx` / `equity_snapshots_ts_idx`
in under a millisecond per 2,000 rows (plans below), and autovacuum reuses the
freed pages for the next day's inserts.

Partitioning would cost: a rewrite of both tables under an exclusive lock, a
job that must create each month's partition before it starts (a missed month
stops every snapshot insert unless a default partition catches it, which then
has to be split by hand), and a schema Drizzle's generator does not describe
(hand-written migrations from then on, and a snapshot that no longer matches
the database). Not worth it at these sizes. Revisit if `position_snapshots`
passes roughly 50 M rows or the nightly delete takes more than a minute.

## Plans

`apps/api/test/manual-retention-plans.e2e-spec.ts` fills an isolated test
database (1.5 M position rows and 0.5 M equity rows over 130 days, 300 k
actions with their queue rows, 150 k alerts, 100 k audit rows, 200 k copy
signals), runs `ANALYZE`, and explains each statement with
`EXPLAIN (ANALYZE, BUFFERS)` inside a transaction that is rolled back. It
fails if any statement reads a table sequentially or sorts. Measured
2026-10-03 (PostgreSQL in Docker on the dev machine); the scans and timings of
one 2,000-row statement per table:

### position_snapshots (1,500,000 rows in position_snapshots, cutoff 2026-07-04)

```
->  Index Scan using position_snapshots_ts_idx on position_snapshots position_snapshots_1 (rows=2000 loops=1)
->  Tid Scan on position_snapshots (rows=2000 loops=1)
Execution Time: 0.850 ms
Rows deleted by this statement: 2000
```

### equity_snapshots (500,000 rows in equity_snapshots, cutoff 2026-07-04)

```
->  Index Scan using equity_snapshots_ts_idx on equity_snapshots equity_snapshots_1 (rows=2000 loops=1)
->  Tid Scan on equity_snapshots (rows=2000 loops=1)
Execution Time: 0.824 ms
Rows deleted by this statement: 2000
```

### admin_audit_logs (100,000 rows in admin_audit_logs, cutoff 2025-10-02)

```
->  Index Scan using admin_audit_logs_created_idx on admin_audit_logs admin_audit_logs_1 (rows=2000 loops=1)
->  Index Scan using admin_audit_logs_pkey on admin_audit_logs (rows=2000 loops=1)
Execution Time: 1.311 ms
Rows deleted by this statement: 2000
```

### account_deletion_records (100,000 rows in admin_audit_logs, cutoff 2025-10-02)

```
->  Index Scan using admin_audit_logs_created_idx on admin_audit_logs admin_audit_logs_1 (rows=949 loops=1)
->  Index Scan using admin_audit_logs_pkey on admin_audit_logs (rows=949 loops=1)
Execution Time: 4.116 ms
Rows deleted by this statement: 949
```

### action_outbox (300,000 rows in action_outbox, cutoff 2026-09-02)

```
->  Index Scan using action_outbox_pending_idx on action_outbox o (rows=2000 loops=1)
->  Index Scan using notification_outbox_pending_idx on notification_outbox n (rows=0 loops=1)
->  Index Scan using action_outbox_pending_idx on action_outbox o_1 (rows=171 loops=1)
->  Index Scan using notification_outbox_pending_idx on notification_outbox n_1 (rows=0 loops=1)
->  Index Scan using action_outbox_pkey on action_outbox (rows=2171 loops=1)
Execution Time: 2.842 ms
Rows deleted by this statement: 2171
```

### notification_outbox (150,000 rows in notification_outbox, cutoff 2026-09-02)

```
->  Index Scan using notification_outbox_pending_idx on notification_outbox n (rows=2000 loops=1)
->  Index Scan using action_outbox_pending_idx on action_outbox o (rows=0 loops=1)
->  Index Scan using notification_outbox_pending_idx on notification_outbox n_1 (rows=0 loops=1)
->  Index Scan using action_outbox_pending_idx on action_outbox o_1 (never executed)
->  Index Scan using notification_outbox_pending_idx on notification_outbox n_2 (rows=0 loops=1)
->  Index Scan using action_outbox_pending_idx on action_outbox o_2 (never executed)
->  Index Scan using notification_outbox_pkey on notification_outbox (rows=2000 loops=1)
Execution Time: 1.917 ms
Rows deleted by this statement: 2000
```

### copy_signal_outbox (200,000 rows in copy_signal_outbox, cutoff 2026-09-02)

```
->  Index Scan using copy_signal_outbox_pkey on copy_signal_outbox s (rows=2000 loops=1)
->  Index Scan using copy_signal_outbox_pending_idx on copy_signal_outbox s_1 (rows=0 loops=1)
->  Index Scan using copy_signal_outbox_pkey on copy_signal_outbox (rows=2000 loops=1)
Execution Time: 1.634 ms
Rows deleted by this statement: 2000
```

### alerts (150,000 rows in alerts, cutoff 2026-09-02)

```
->  Index Scan using alerts_sent_at_idx on alerts a (rows=2000 loops=1)
->  Index Scan using alerts_unsent_idx on alerts a_1 (rows=0 loops=1)
->  Index Scan using actions_pkey on actions x (never executed)
->  Index Scan using notification_outbox_pending_idx on notification_outbox n (never executed)
->  Index Scan using alerts_pkey on alerts (rows=2000 loops=1)
Execution Time: 1.553 ms
Rows deleted by this statement: 2000
```

Before the migration, `position_snapshots` had only its primary key
(chain, address, coin, ts) and `equity_snapshots` its primary key and
(address, ts): `ts < cutoff` could only be answered by reading the whole
table. Migration `0024_retention` adds the two `ts` indexes, a partial index
on `alerts` rows without `sent_at`, and `retention_state`.

Run it again with:

```
E2E_RETENTION_PLANS=1 E2E_OUT=/tmp/retention-plans.txt TEST_DATABASE_ADMIN_URL=… \
  node scripts/test-api-isolated.mjs --config ./vitest.config.e2e.ts test/manual-retention-plans.e2e-spec.ts
```

## The policy's statements

| Statement (privacy §6, delete-account) | In the code |
| --- | --- |
| Alert delivery records are kept 30 days | `alerts` and finished `notification_outbox` rows are deleted after 30 days by this job |
| Admin audit logs and account-deletion records are kept 1 year | `admin_audit_logs`, both kinds, deleted after 365 days |
| A deletion record holds only an account number, a time and counts | `AccountRepository.recordDeletion`: role, favorites, alerts, groups, telegramLinked |
| The Telegram link is deleted when you unlink; the chat ID in records of sent alerts goes with the record after 30 days | `TelegramLinkRepository.unlink` deletes `notification_channels`; the delivery payload (`notification_outbox`, `alerts`) carries the chat ID until this job removes the row |
| Account data is removed at once on self-deletion; paper copy records go with the account | `users` row deleted, foreign keys cascade (favorites, groups, alerts, channels, tokens, queued notifications, paper account, strategies and their orders, fills, positions, ledger) |
| Server logs are kept 30 days | not in this repository: it is the host's (Railway's) log retention and has not been checked |
| Backups are overwritten within 30 days | not in this repository: no backup schedule is configured yet (see backup-and-restore.md) |

Not stated in the policy and not cleaned by this job: `copy_controls` /
`copy_control_events` rows an admin wrote for a single user keep that user's
account number after the account is deleted.
