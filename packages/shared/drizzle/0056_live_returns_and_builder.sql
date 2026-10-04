CREATE TABLE "copy_live_builder_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"builder_address" text NOT NULL,
	"max_fee_tenths_bps" integer NOT NULL,
	"nonce" bigint NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"attempted_at" timestamp with time zone,
	"evidence_digest" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_builder_approvals_check" CHECK ("copy_live_builder_approvals"."network" = 'testnet' and "copy_live_builder_approvals"."state" in ('prepared', 'unknown', 'accepted', 'rejected', 'approved') and "copy_live_builder_approvals"."max_fee_tenths_bps" between 1 and 100 and "copy_live_builder_approvals"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_builder_approvals"."builder_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_builder_approvals"."nonce" > 0 and ("copy_live_builder_approvals"."state" = 'prepared' or "copy_live_builder_approvals"."attempted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "direction" text DEFAULT 'to_account' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "stop_id" text;--> statement-breakpoint
ALTER TABLE "copy_live_builder_approvals" ADD CONSTRAINT "copy_live_builder_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_builder_approvals" ADD CONSTRAINT "copy_live_builder_approvals_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_builder_approvals_key_uq" ON "copy_live_builder_approvals" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_builder_approvals_nonce_uq" ON "copy_live_builder_approvals" USING btree ("network","account_address","nonce");--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_stop_id_copy_live_stop_operations_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."copy_live_stop_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_direction_check" CHECK ("copy_funding_operations"."direction" in ('to_account', 'to_main') and ("copy_funding_operations"."stop_id" is null or "copy_funding_operations"."direction" = 'to_main'));