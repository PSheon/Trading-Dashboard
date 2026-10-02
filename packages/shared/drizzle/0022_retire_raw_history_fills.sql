-- The fills moved to "history_fills" (0021). A raw table without rows (a new
-- database) is dropped here. One that still holds rows is left untouched for
-- `pnpm --filter @trading-dashboard/api history:convert`, which copies them
-- in batches, checks every row and only then retires the table; the api and
-- the worker do not start while a raw table with rows exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "analysis_history_fills") THEN
    DROP TABLE "analysis_history_fills";
  END IF;
END $$;
