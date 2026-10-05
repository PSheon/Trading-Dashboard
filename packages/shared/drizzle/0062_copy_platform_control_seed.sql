-- One-click testnet copy, step 2 (docs/one-click-copy-plan-2026-10-05.md §3e,
-- Paul's decision 5): live preparation and the live risk authority require the
-- platform control row and an explicit risk policy, and neither was ever
-- written on a fresh deployment. Paper treats a missing platform row as clear,
-- so the seeded row (nothing paused, not reduce-only) changes nothing for it.
INSERT INTO "copy_controls" ("scope", "scope_id", "pause_new_risk", "reduce_only")
VALUES ('platform', 0, false, false)
ON CONFLICT ("scope", "scope_id") DO NOTHING;--> statement-breakpoint
-- Version 1 of the risk policy is today's DEFAULT_COPY_RISK_LIMITS (the values
-- paper already applies when no version exists), written only when no admin
-- has saved a policy. An admin save still creates version 2 and later.
INSERT INTO "copy_risk_policies" ("limits", "reason", "created_by_user_id")
SELECT '{"paperStartingBalanceUsd":10000,"minAllocationUsd":100,"maxAllocationUsd":100000,"maxStrategiesPerUser":10,"maxLeverage":10,"maxOrderNotionalUsd":50000,"minOrderNotionalUsd":10,"maxCoinExposureUsd":100000,"maxUserExposureUsd":250000,"maxSlippageBps":50,"simulatedSlippageBps":5,"takerFeeBps":4.5,"maxSignalAgeSeconds":120,"maxOrdersPerMinute":30,"allowHip3":false,"blockedCoins":[]}'::jsonb,
  'seeded defaults', NULL
WHERE NOT EXISTS (SELECT 1 FROM "copy_risk_policies");
