CREATE TABLE "copy_live_stop_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"original_mandate_revision" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"owner_privy_user_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"account_wallet_id" text NOT NULL,
	"account_owner_quorum_id" text NOT NULL,
	"original_intent_digest" text NOT NULL,
	"original_consent_digest" text NOT NULL,
	"desired_action" text DEFAULT 'cancel_and_close' NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"target_manifest" jsonb NOT NULL,
	"target_digest" text NOT NULL,
	"tracked_execution_count" integer NOT NULL,
	"tracking_complete" boolean NOT NULL,
	"issue" text,
	"flat_certificate" jsonb,
	"flat_digest" text,
	"flat_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_stops_identity_check" CHECK ("copy_live_stop_operations"."network" = 'testnet' and "copy_live_stop_operations"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_stop_operations"."owner_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_stop_operations"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_stop_operations"."owner_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_stop_operations"."owner_address" <> "copy_live_stop_operations"."account_address" and length("copy_live_stop_operations"."owner_privy_user_id") between 1 and 128 and length("copy_live_stop_operations"."account_wallet_id") between 1 and 128 and length("copy_live_stop_operations"."account_owner_quorum_id") between 1 and 128),
	CONSTRAINT "copy_live_stops_request_check" CHECK ("copy_live_stop_operations"."original_mandate_revision" > 0 and "copy_live_stop_operations"."revision" > 0 and "copy_live_stop_operations"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$' and "copy_live_stop_operations"."desired_action" = 'cancel_and_close' and "copy_live_stop_operations"."tracked_execution_count" between 0 and 1000),
	CONSTRAINT "copy_live_stops_manifest_check" CHECK (jsonb_typeof("copy_live_stop_operations"."target_manifest") = 'object' and octet_length("copy_live_stop_operations"."target_manifest"::text) <= 2097152 and "copy_live_stop_operations"."target_digest" ~ '^[0-9a-f]{64}$' and "copy_live_stop_operations"."original_intent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_stop_operations"."original_consent_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "copy_live_stops_state_check" CHECK ("copy_live_stop_operations"."state" in ('requested','cancelling','closing','blocked','flat','stopped') and ("copy_live_stop_operations"."state" <> 'blocked' or "copy_live_stop_operations"."issue" is not null) and ("copy_live_stop_operations"."issue" is null or "copy_live_stop_operations"."issue" ~ '^[a-z][a-z0-9_]{0,79}$') and ("copy_live_stop_operations"."tracking_complete" or "copy_live_stop_operations"."state" = 'blocked')),
	CONSTRAINT "copy_live_stops_flat_check" CHECK ((("copy_live_stop_operations"."state" in ('flat','stopped')) and "copy_live_stop_operations"."flat_certificate" is not null and jsonb_typeof("copy_live_stop_operations"."flat_certificate") = 'object' and "copy_live_stop_operations"."flat_digest" is not null and "copy_live_stop_operations"."flat_digest" ~ '^[0-9a-f]{64}$' and "copy_live_stop_operations"."flat_verified_at" is not null and "copy_live_stop_operations"."flat_verified_at" >= "copy_live_stop_operations"."created_at" and "copy_live_stop_operations"."flat_verified_at" <= "copy_live_stop_operations"."updated_at") or (("copy_live_stop_operations"."state" not in ('flat','stopped')) and "copy_live_stop_operations"."flat_certificate" is null and "copy_live_stop_operations"."flat_digest" is null and "copy_live_stop_operations"."flat_verified_at" is null)),
	CONSTRAINT "copy_live_stops_time_check" CHECK ("copy_live_stop_operations"."updated_at" >= "copy_live_stop_operations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "copy_live_stop_operations" ADD CONSTRAINT "copy_live_stop_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_operations" ADD CONSTRAINT "copy_live_stop_operations_strategy_id_copy_live_strategy_configs_strategy_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_live_strategy_configs"("strategy_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_operations" ADD CONSTRAINT "copy_live_stop_operations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_stop_operations" ADD CONSTRAINT "copy_live_stop_operations_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_stops_key_uq" ON "copy_live_stop_operations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_stops_account_uq" ON "copy_live_stop_operations" USING btree ("account_id") WHERE "copy_live_stop_operations"."state" <> 'stopped';--> statement-breakpoint
CREATE INDEX "copy_live_stops_owner_idx" ON "copy_live_stop_operations" USING btree ("user_id","created_at");