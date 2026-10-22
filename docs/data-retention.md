# Data retention

What the privacy policy (§6) promises, what the worker deletes, and why the
snapshot tables are not partitioned. Review findings 3 and 20; owner's
periods of 2026-10-01.

## Periods

| Data | Table | Default | Variable (worker) |
| --- | --- | --- | --- |
| Position and equity snapshots | `position_snapshots`, `equity_snapshots` | 90 days | `RETENTION_SNAPSHOT_DAYS` (30–3650) |
| Admin audit log | `admin_audit_logs` (every event except `user.delete`) | 1 year | `RETENTION_AUDIT_DAYS` (30–3650) |
| Account-deletion records | `admin_audit_logs` where `event = 'user.delete'` | 1 year | `RETENTION_ACCOUNT_DELETION_DAYS` (30–3650) |
| Deleted accounts' kept records | the tombstone `users` row (`deleted_at`) and every record re-pointed to it (`purgeStatements`, docs/account-deletion.md) | 1 year after the deletion | `RETENTION_ACCOUNT_DELETION_DAYS` |
| Deleted identities (keyed hashes) | `account_deletion_markers` | 1 year after the deletion | `RETENTION_ACCOUNT_DELETION_DAYS` |
| Finished evaluations | `action_outbox` (`done`, `failed`) | 30 days | `RETENTION_QUEUE_DAYS` (7–3650) |
| Finished deliveries | `notification_outbox` (`sent`, `dry_run`, `failed`) | 30 days | `RETENTION_QUEUE_DAYS` |
| Finished copy signals | `copy_signal_outbox` (`done`, `failed`) | 30 days | `RETENTION_QUEUE_DAYS` |
| Alert delivery records | `alerts` | 30 days | `RETENTION_ALERT_DAYS` (7–3650) |
| Closed Hyperliquid socket leases (with their cleanup evidence) | `hyperliquid_ws_leases` where `state = 'closed'` | 1 day after `closed_at` | fixed (`CLOSED_WS_LEASE_RETENTION_MS`) |
| A paper copy's per-minute valuations, thinned to the first and last of each UTC hour | `copy_equity_snapshots` of `mode = 'paper'` copies | 31 days before the copy's end (its stop, or now) | `RETENTION_COPY_EQUITY_FULL_DAYS` (31–3650) |
| Cohort history rows' member lists (`member_addresses` cleared; the row, its figures and `membership_version` stay) | `cohort_snapshots` | 30 days | `RETENTION_COHORT_MEMBER_LIST_DAYS` (7–3650) |
| A live account's superseded follower observations | `copy_follower_observations` other than the one `copy_follower_observation_jobs.latest_observation_id` names | 7 days | `RETENTION_FOLLOWER_OBSERVATION_DAYS` (1–3650) |
| Traders' stored fill history (public market data; Paul, 2026-10-22) | `history_fills`, except the leaders of copy strategies not stopped | from 00:00 UTC of the day 90 days back | `RETENTION_HISTORY_FILL_DAYS` (30–3650) |

The periods are deploy-time since 2026-10-05 (they were `general.retention`
in the admin settings): set them on the worker and restart it;
`RETENTION_ENABLED=false` stops the job. The defaults are the periods the
policy states: changing one makes the policy untrue until its text is changed
too. Each run's audit entry (`retention.run`) records the periods it used.

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
- A Hyperliquid socket lease that is not closed (`reserved`, `open`,
  `closing`, `uncertain`), however old: it still reserves connection capacity
  until it is closed or past the meter's stale margin, and the meter reads it.
  A closed lease is never read (a request naming one is refused exactly as one
  naming a missing lease).
- A live copy's valuations (`copy_equity_snapshots` of a `testnet` copy), and of a
  paper copy's, the first and last of every hour and everything of its last 31
  days. The copy's charts read those days at full resolution: its 1d/7d/30d
  windows (counted back from its stop, or now) never reach a thinned hour, and
  its whole-life views (the "all" window, the portfolio's "all" series and the
  sparklines, a thousandth of the life at most) read a valuation of a thinned
  hour with `COPY_EQUITY_THINNED_FRESH_MS` (an hour and two minutes) instead of
  `FRESH_MS`, so the thinning is not a hole and a longer gap still is. The api
  starts reading thinned hours at `COPY_EQUITY_FULL_RESOLUTION_MS` (31 days),
  which is why `RETENTION_COPY_EQUITY_FULL_DAYS` may not go below it.
- A cohort history row itself: only its member list is cleared. No reader uses
  the list (the 倉位傾向 chart reads the figures and `membership_version`).
- An account's latest follower observation, however old (the only one any
  reader uses: the owner's snapshot, the actual copy's valuation and whether the
  account still holds funds), and any observation a row references
  (`ON DELETE RESTRICT`).
- `actions`. Both outboxes reference `actions` with `ON DELETE CASCADE`, so
  deleting an action would take its queue rows with it. The job deletes queue
  rows only, which cascades to nothing: no table references `action_outbox`,
  `notification_outbox`, `copy_signal_outbox` or `alerts`.
- `fills`, `fill_coverage`, `trader_trades`, copy orders, fills and ledger:
  not in scope (the watcher's copy signal source, derived figures, or the
  user's own records kept for the life of the account).
- A copied leader's `history_fills` (a leader of a copy strategy not stopped)
  and its archive span: kept whole while the copy runs.

## The history sweep (`history_fills`)

`history_fills` holds ~180 M rows and gains ~2 M a day, 4 times what the
table loop's 500,000 rows per table per run could remove, so it has its own
sweep in the same run, after the tables (and their paper-valuation, cohort
member list and follower observation steps):

1. **The cut first.** In one transaction: `archive_ingest_state.retained_from`
   becomes the cut (the archive backfill never reads or certifies an hour
   below it) and every `archive_coverage` span starting before it starts at it
   (a span wholly before it is emptied; the live cursor starts it again). From
   here on nothing reports as held what is being deleted.
2. **Bounded deletes.** One `DELETE` removes at most a batch of rows
   (1,000 to start, `HISTORY_RETENTION_BATCH_LIMIT`): the oldest rows below the cut of the
   accounts at or after a cursor, in account-id order, each found through
   `history_fills_account_time_idx` (an account with nothing to delete costs
   one index probe). The rows of an account nothing refers to any more (no
   history job, no active archive span) go whatever their age: they are what
   an expired job or a dropped address left. After each statement the sweep
   waits as long as the statement took (at least 200 ms), so it holds the
   database at most half the time; the lease is extended after each.
   The batch adapts, because a cold heap costs a random page read per row: a
   statement cancelled by `statement_timeout` (15 s; SQLSTATE 57014) rolled
   back whole, so the batch halves and the same rows are tried again, down to
   100 (`HISTORY_RETENTION_BATCH_FLOOR`; a timeout there fails the run and
   the next tick retries). A statement slower than 2 s
   (`HISTORY_RETENTION_TARGET_MS`) halves it as well; one under 1 s grows it
   by a quarter, up to 5,000 (`HISTORY_RETENTION_BATCH_CAP`).
3. **Continued.** A sweep the run's 20 minutes cut short is continued by the
   window's later ticks (three an hour, 18–22 UTC) until it reaches the day's
   cut, without repeating the tables or overwriting the last run's record;
   `retention_state.history_cut` is the cut the last complete sweep reached.
   Each run's `retention.run` audit carries `history` (cut, rows, complete,
   the batch it ended at and the statements cancelled).

**Throughput.** At most half the time is spent deleting. Warm, at the cap
(5,000 rows in ~0.5 s): ~5,000 rows/s, so the steady ~2 M rows a day take ~7
minutes and the 4-hour window can remove up to ~72 M rows a night. Cold, at
the floor's worst (100 rows a statement near 2 s): ~25 rows/s, ~0.36 M a night,
which does not keep up; the batch then sits wherever statements take 1–2 s
(for example 1,000 rows in 1.5 s: ~330 rows/s, ~4.8 M a night, ahead of the
~2 M a day). Stage to be measured: the audit's `history.batch`, rows and
duration.

**What figures show after a cut.** Figures built from stored history (the
durable job's snapshot, an archive-covered first build) start at the first
kept fill: "all" means the last 90 days for them, and their coverage says
`from` that date and partial, which the trader page already shows ("since …").
A ledger built before the cut is rebuilt from the kept snapshot when the job
publishes its next one. Watched addresses are rebuilt from `fills` (365 days,
not pruned) and use the archive only where its span (now from the cut)
reaches back further. Cold REST reads still look back up to 365 days.

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
| A deletion record holds only an account number, a time and counts | `AccountRepository.recordDeletion`: role, favorites, alerts, groups, telegramLinked; after: the tombstone id and counts of what was kept, cancelled and revoked |
| Kept financial records are anonymous and deleted 1 year after the deletion | re-pointed to the tombstone (`repointStatements`), purged with it by `deleted_accounts` |
| Only keyed hashes of the identity are kept, 1 year, to stop invite farming | `account_deletion_markers` (deletion-markers.ts), purged by `account_deletion_markers` |
| The Telegram link is deleted when you unlink; the chat ID in records of sent alerts goes with the record after 30 days | `TelegramLinkRepository.unlink` deletes `notification_channels`; the delivery payload (`notification_outbox`, `alerts`) carries the chat ID until this job removes the row |
| Account data is removed at once on self-deletion; paper copy records go with the account | `users` row deleted, foreign keys cascade (favorites, groups, alerts, channels, tokens, queued notifications, paper account, strategies and their orders, fills, positions, ledger) |
| Server logs are kept 30 days | not in this repository: it is the host's (Railway's) log retention and has not been checked |
| Backups are overwritten within 30 days | not in this repository: no backup schedule is configured yet (see backup-and-restore.md) |

Not stated in the policy and not cleaned by this job: `copy_controls` /
`copy_control_events` rows an admin wrote for a single user keep that user's
account number after the account is deleted.
