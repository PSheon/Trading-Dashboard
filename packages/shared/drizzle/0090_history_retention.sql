-- History retention (2026-10-22, approved by Paul: history_fills keeps 90 days; addresses that leave the tracked set
-- stop growing it). Three nullable columns, no default, no rewrite, no backfill: every existing row reads as before.
-- archive_coverage.untracked_since: when an active address was first seen outside the tracked set; after a grace
-- period its coverage row is deleted (no longer ingested; its history job can then expire). Null = in the set.
-- archive_ingest_state.retained_from: the history_fills retention cut, written by the retention job before it
-- deletes; the archive backfill never reads or certifies below it. Null = nothing pruned yet.
-- retention_state.history_cut: the cut the last complete history sweep reached (later ticks continue until it is today's).
-- Rollback: drop the three columns (the app before this change never reads them).
ALTER TABLE "archive_coverage" ADD COLUMN "untracked_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "archive_ingest_state" ADD COLUMN "retained_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_state" ADD COLUMN "history_cut" timestamp with time zone;
