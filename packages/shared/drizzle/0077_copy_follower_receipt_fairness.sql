ALTER TABLE "copy_follower_observation_budget" ADD COLUMN "next_receipt_allowed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "copy_follower_observation_budget" ADD COLUMN "next_snapshot_allowed_at" timestamp with time zone;
