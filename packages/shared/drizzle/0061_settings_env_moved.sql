-- Admin simplification (Paul, 2026-10-05): the Hyperliquid weight caps, the
-- discovery refresh/size knobs and data retention became deploy-time
-- settings (HYPERLIQUID_*_WEIGHT_PER_MIN, DISCOVERY_*, RETENTION_*), and the
-- two settings nobody read (discovery.featuredAddresses,
-- revenue.referralCode) were deleted. Strip them from the stored sections so
-- the saved JSON matches the schema; every other field is kept as saved.
UPDATE "app_settings"
SET "value" = "value" - ARRAY['featuredAddresses', 'leaderboardRefreshMinutes', 'candidatePoolSize', 'poolWeightPerMinute',
  'poolPerformanceWeightPerMinute', 'historyWeightPerMinute', 'backfillWeightPerMinute', 'cohortMembersPerTier',
  'cohortRefreshMinutes', 'cohortWeightPerMinute']
WHERE "key" = 'discovery' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
UPDATE "app_settings" SET "value" = "value" - 'retention'
WHERE "key" = 'general' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
UPDATE "app_settings" SET "value" = "value" - 'referralCode'
WHERE "key" = 'revenue' AND jsonb_typeof("value") = 'object';
