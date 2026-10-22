-- Leaderboard import marker (cost reduction 2026-10-22, §1 #8, approved): an import rewrote every trader_stats row
-- (~19k, three indexed columns) every 15 minutes only to stamp updated_at. It now rewrites a row only when its figures
-- change, so "when was the leaderboard imported" moves here, one row per chain, written in the import's transaction.
-- Seeded from trader_stats (every row carries the last import's time until the first import of this release).
-- Small and new: no lock on any existing table beyond a read of trader_stats.
-- Rollback: DROP TABLE "leaderboard_imports" with the previous release (which reads only trader_stats.updated_at;
-- its next import stamps every row again).
CREATE TABLE "leaderboard_imports" (
	"chain" text PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
INSERT INTO "leaderboard_imports" ("chain", "imported_at") SELECT "chain", max("updated_at") FROM "trader_stats" GROUP BY "chain";
