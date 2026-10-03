CREATE TABLE "copy_live_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"execution_wallet_id" text NOT NULL,
	"authorization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"network" text NOT NULL,
	"source_network" text NOT NULL,
	"leader_address" text NOT NULL,
	"account_address" text NOT NULL,
	"account_revision" integer NOT NULL,
	"owner_privy_user_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"setup_revision" integer NOT NULL,
	"authorization_version" integer NOT NULL,
	"strategy_version" integer NOT NULL,
	"agent_wallet_id" text NOT NULL,
	"agent_address" text NOT NULL,
	"policy_id" text NOT NULL,
	"policy_fingerprint" text NOT NULL,
	"worker_quorum_id" text NOT NULL,
	"settings_digest" text NOT NULL,
	"budget_usd" text NOT NULL,
	"builder_address" text,
	"builder_max_fee_tenths_of_bps" integer DEFAULT 0 NOT NULL,
	"planner_version" integer DEFAULT 1 NOT NULL,
	"nonce" bigint NOT NULL,
	"intent" jsonb NOT NULL,
	"intent_digest" text NOT NULL,
	"consent_digest" text,
	"state" text DEFAULT 'prepared' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"activation_cursor" timestamp with time zone,
	"consent_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_mandates_network_check" CHECK ("copy_live_mandates"."network" = 'testnet' and "copy_live_mandates"."source_network" in ('testnet','mainnet')),
	CONSTRAINT "copy_live_mandates_state_check" CHECK ("copy_live_mandates"."state" in ('prepared', 'active', 'paused', 'stopping', 'stopped', 'revoked', 'expired')),
	CONSTRAINT "copy_live_mandates_versions_check" CHECK ("copy_live_mandates"."revision" >= 1 and "copy_live_mandates"."account_revision" >= 1 and "copy_live_mandates"."setup_revision" >= 1 and "copy_live_mandates"."authorization_version" >= 1 and "copy_live_mandates"."strategy_version" >= 1 and "copy_live_mandates"."planner_version" = 1),
	CONSTRAINT "copy_live_mandates_identity_check" CHECK ("copy_live_mandates"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_mandates"."account_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_mandates"."owner_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_mandates"."owner_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_mandates"."agent_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_mandates"."agent_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_mandates"."leader_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_mandates"."leader_address" <> '0x0000000000000000000000000000000000000000' and "copy_live_mandates"."account_address" <> "copy_live_mandates"."owner_address" and "copy_live_mandates"."account_address" <> "copy_live_mandates"."agent_address" and "copy_live_mandates"."owner_address" <> "copy_live_mandates"."agent_address"),
	CONSTRAINT "copy_live_mandates_hash_check" CHECK ("copy_live_mandates"."intent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_mandates"."settings_digest" ~ '^[0-9a-f]{64}$' and "copy_live_mandates"."policy_fingerprint" ~ '^[0-9a-f]{64}$' and ("copy_live_mandates"."consent_digest" is null or "copy_live_mandates"."consent_digest" ~ '^[0-9a-f]{64}$') and jsonb_typeof("copy_live_mandates"."intent") = 'object'),
	CONSTRAINT "copy_live_mandates_budget_check" CHECK ("copy_live_mandates"."budget_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and length("copy_live_mandates"."budget_usd") <= 32 and "copy_live_mandates"."budget_usd"::numeric > 0 and "copy_live_mandates"."builder_max_fee_tenths_of_bps" between 0 and 100 and (("copy_live_mandates"."builder_address" is null and "copy_live_mandates"."builder_max_fee_tenths_of_bps" = 0) or ("copy_live_mandates"."builder_address" is not null and "copy_live_mandates"."builder_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_mandates"."builder_address" <> '0x0000000000000000000000000000000000000000'))),
	CONSTRAINT "copy_live_mandates_time_check" CHECK ("copy_live_mandates"."nonce" > 0 and "copy_live_mandates"."nonce" <= 9007199254740991 and extract(epoch from "copy_live_mandates"."consent_expires_at") * 1000 > "copy_live_mandates"."nonce" and extract(epoch from "copy_live_mandates"."consent_expires_at") * 1000 <= "copy_live_mandates"."nonce" + 300000 and "copy_live_mandates"."expires_at" > "copy_live_mandates"."consent_expires_at" and extract(epoch from "copy_live_mandates"."expires_at") * 1000 <= "copy_live_mandates"."nonce" + 2592000000 and "copy_live_mandates"."updated_at" >= "copy_live_mandates"."created_at"),
	CONSTRAINT "copy_live_mandates_activation_check" CHECK ("copy_live_mandates"."state" not in ('active','paused','stopping','stopped') or ("copy_live_mandates"."consent_digest" is not null and "copy_live_mandates"."activation_cursor" is not null and "copy_live_mandates"."activation_cursor" >= "copy_live_mandates"."created_at" and "copy_live_mandates"."activation_cursor" < "copy_live_mandates"."expires_at")),
	CONSTRAINT "copy_live_mandates_key_check" CHECK ("copy_live_mandates"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$')
);
--> statement-breakpoint
CREATE TABLE "copy_live_strategy_configs" (
	"strategy_id" integer PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_network" text NOT NULL,
	"budget_usd" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_live_configs_network_check" CHECK ("copy_live_strategy_configs"."source_network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_live_configs_budget_check" CHECK ("copy_live_strategy_configs"."budget_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and length("copy_live_strategy_configs"."budget_usd") <= 32 and "copy_live_strategy_configs"."budget_usd"::numeric > 0 and "copy_live_strategy_configs"."strategy_version" >= 1),
	CONSTRAINT "copy_live_configs_key_check" CHECK ("copy_live_strategy_configs"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$')
);
--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_strategy_id_copy_live_strategy_configs_strategy_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_live_strategy_configs"("strategy_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_setup_id_copy_agent_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."copy_agent_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_execution_wallet_id_copy_execution_wallets_id_fk" FOREIGN KEY ("execution_wallet_id") REFERENCES "public"."copy_execution_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_authorization_id_copy_wallet_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."copy_wallet_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_strategy_configs" ADD CONSTRAINT "copy_live_strategy_configs_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_strategy_configs" ADD CONSTRAINT "copy_live_strategy_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_mandates_key_uq" ON "copy_live_mandates" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_mandates_current_uq" ON "copy_live_mandates" USING btree ("strategy_id") WHERE "copy_live_mandates"."state" not in ('stopped', 'revoked', 'expired');--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_mandates_account_uq" ON "copy_live_mandates" USING btree ("network","account_id") WHERE "copy_live_mandates"."state" not in ('stopped', 'revoked', 'expired');--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_mandates_nonce_uq" ON "copy_live_mandates" USING btree ("user_id","nonce");--> statement-breakpoint
CREATE INDEX "copy_live_mandates_owner_idx" ON "copy_live_mandates" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_configs_key_uq" ON "copy_live_strategy_configs" USING btree ("user_id","idempotency_key");