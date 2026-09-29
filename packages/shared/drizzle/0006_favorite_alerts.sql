ALTER TABLE "alerts" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
-- Custom: per-user alert rules are gone (users set alerts on favorites;
-- admins use the default rules directly). Alerts that referenced a user's
-- copy of a rule now point at the default rule of the same kind, or at no
-- rule when there is no such default; then the copies are deleted.
UPDATE "alerts" SET "rule_id" = (
  SELECT d."id" FROM "alert_rules" d
  WHERE d."user_id" IS NULL AND d."kind" = (SELECT u."kind" FROM "alert_rules" u WHERE u."id" = "alerts"."rule_id")
)
WHERE "rule_id" IN (SELECT "id" FROM "alert_rules" WHERE "user_id" IS NOT NULL);--> statement-breakpoint
DELETE FROM "alert_rules" WHERE "user_id" IS NOT NULL;
