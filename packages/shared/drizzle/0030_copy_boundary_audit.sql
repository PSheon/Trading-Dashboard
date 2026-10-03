ALTER TABLE "copy_orders" ADD COLUMN "execution_policy_version" integer;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD COLUMN "execution_strategy_version" integer;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD COLUMN "execution_control_revisions" jsonb;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD COLUMN "execution_fee_snapshot" jsonb;