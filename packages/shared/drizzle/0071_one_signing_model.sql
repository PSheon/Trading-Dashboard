-- The one signing model (2026-10-07): every copy-account action is signed by the worker under the owner's Privy policy.
-- A setup still in flight under the browser-signed path (owner_session) can't go on: it ends failed with its own issue
-- (its deposit, if any, stays in the copy account and is returned from the portfolio).
UPDATE "copy_live_setups" SET "stage" = 'failed', "issue" = 'signer_model_changed', "next_attempt_at" = NULL, "lease_until" = NULL, "lease_token" = NULL,
  "revision" = "revision" + 1, "updated_at" = now()
  WHERE "signer_kind" = 'owner_session' AND "stage" NOT IN ('running', 'failed', 'expired', 'cancelled');--> statement-breakpoint
ALTER TABLE "copy_funding_operations" DROP CONSTRAINT "copy_funding_signer_kind_check";--> statement-breakpoint
ALTER TABLE "copy_live_setups" DROP CONSTRAINT "copy_live_setups_signer_check";--> statement-breakpoint
ALTER TABLE "copy_live_setups" DROP CONSTRAINT "copy_live_setups_consent_check";--> statement-breakpoint
ALTER TABLE "copy_funding_operations" DROP COLUMN "signer_kind";--> statement-breakpoint
ALTER TABLE "copy_live_setups" DROP COLUMN "signer_kind";--> statement-breakpoint
ALTER TABLE "copy_live_setups" DROP COLUMN "pending_signature";--> statement-breakpoint
ALTER TABLE "copy_live_setups" DROP COLUMN "owner_signature";--> statement-breakpoint
ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_consent_check" CHECK ("copy_live_setups"."stage" in ('provisioning', 'awaiting_consent', 'failed', 'expired', 'cancelled') or ("copy_live_setups"."consent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setups"."intent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setups"."confirmed_at" is not null and "copy_live_setups"."setup_deadline" is not null));