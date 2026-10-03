CREATE TABLE "copy_live_risk_reservations" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"cloid" text NOT NULL,
	"fingerprint" text NOT NULL,
	"wallet_id" text NOT NULL,
	"authorization_id" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"authorization_version" integer NOT NULL,
	"coin" text NOT NULL,
	"dex" text NOT NULL,
	"asset" integer NOT NULL,
	"notional_usd" text NOT NULL,
	"margin_usd" text NOT NULL,
	"fee_buffer_usd" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"exchange_order_id" text,
	"attempted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"release_reason" text,
	"release_evidence_digest" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_risk_reservations_identity_check" CHECK ("copy_live_risk_reservations"."network" = 'testnet' and "copy_live_risk_reservations"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_risk_reservations"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_risk_reservations"."cloid" ~ '^0x[0-9a-f]{32}$' and "copy_live_risk_reservations"."fingerprint" ~ '^[0-9a-f]{64}$' and "copy_live_risk_reservations"."source_digest" ~ '^[0-9a-f]{64}$' and length("copy_live_risk_reservations"."wallet_id") between 1 and 128 and "copy_live_risk_reservations"."asset" >= 0),
	CONSTRAINT "copy_live_risk_reservations_versions_check" CHECK ("copy_live_risk_reservations"."strategy_version" > 0 and "copy_live_risk_reservations"."policy_version" > 0 and "copy_live_risk_reservations"."authorization_version" > 0 and "copy_live_risk_reservations"."revision" > 0),
	CONSTRAINT "copy_live_risk_reservations_amounts_check" CHECK ("copy_live_risk_reservations"."notional_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' and length("copy_live_risk_reservations"."notional_usd") <= 80 and "copy_live_risk_reservations"."notional_usd"::numeric > 0 and "copy_live_risk_reservations"."margin_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' and length("copy_live_risk_reservations"."margin_usd") <= 80 and "copy_live_risk_reservations"."margin_usd"::numeric >= 0 and "copy_live_risk_reservations"."fee_buffer_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' and length("copy_live_risk_reservations"."fee_buffer_usd") <= 80 and "copy_live_risk_reservations"."fee_buffer_usd"::numeric >= 0),
	CONSTRAINT "copy_live_risk_reservations_payload_check" CHECK (jsonb_typeof("copy_live_risk_reservations"."payload") = 'object' and "copy_live_risk_reservations"."payload" ? 'intent' and "copy_live_risk_reservations"."payload" ? 'action'),
	CONSTRAINT "copy_live_risk_reservations_time_check" CHECK ("copy_live_risk_reservations"."expires_at" > "copy_live_risk_reservations"."created_at" and "copy_live_risk_reservations"."updated_at" >= "copy_live_risk_reservations"."created_at"),
	CONSTRAINT "copy_live_risk_reservations_state_check" CHECK ("copy_live_risk_reservations"."state" in ('held', 'unknown', 'resting', 'released', 'quarantined')),
	CONSTRAINT "copy_live_risk_reservations_order_check" CHECK (("copy_live_risk_reservations"."exchange_order_id" is null or "copy_live_risk_reservations"."exchange_order_id" ~ '^[1-9][0-9]*$') and ("copy_live_risk_reservations"."state" <> 'held' or ("copy_live_risk_reservations"."attempted_at" is null and "copy_live_risk_reservations"."exchange_order_id" is null)) and ("copy_live_risk_reservations"."state" not in ('unknown', 'resting') or "copy_live_risk_reservations"."attempted_at" is not null) and ("copy_live_risk_reservations"."state" <> 'resting' or "copy_live_risk_reservations"."exchange_order_id" is not null)),
	CONSTRAINT "copy_live_risk_reservations_release_check" CHECK (("copy_live_risk_reservations"."state" <> 'released' and "copy_live_risk_reservations"."release_reason" is null and "copy_live_risk_reservations"."release_evidence_digest" is null) or ("copy_live_risk_reservations"."state" = 'released' and "copy_live_risk_reservations"."release_reason" is not null and "copy_live_risk_reservations"."release_evidence_digest" is not null and "copy_live_risk_reservations"."release_evidence_digest" ~ '^[0-9a-f]{64}$' and (("copy_live_risk_reservations"."release_reason" = 'unattempted_expired' and "copy_live_risk_reservations"."attempted_at" is null and "copy_live_risk_reservations"."exchange_order_id" is null) or ("copy_live_risk_reservations"."release_reason" = 'verified_settlement' and "copy_live_risk_reservations"."attempted_at" is not null))))
);
--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_key_copy_live_executions_key_fk" FOREIGN KEY ("key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_risk_reservations" ADD CONSTRAINT "copy_live_risk_reservations_authorization_id_copy_wallet_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."copy_wallet_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_risk_reservations_cloid_uq" ON "copy_live_risk_reservations" USING btree ("network","account_address","cloid");--> statement-breakpoint
CREATE INDEX "copy_live_risk_reservations_owner_idx" ON "copy_live_risk_reservations" USING btree ("user_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "copy_live_risk_reservations_account_idx" ON "copy_live_risk_reservations" USING btree ("account_id","state");