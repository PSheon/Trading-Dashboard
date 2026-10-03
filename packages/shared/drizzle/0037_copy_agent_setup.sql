CREATE TABLE "copy_agent_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"network" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"valid_for_days" integer NOT NULL,
	"external_id" text NOT NULL,
	"worker_quorum_id" text NOT NULL,
	"policy_attempt_id" text NOT NULL,
	"policy_id" text,
	"policy_fingerprint" text,
	"policy_started_at" timestamp with time zone,
	"policy_request_expiry" bigint,
	"agent_wallet_id" text,
	"agent_owner_quorum_id" text,
	"agent_address" text,
	"account_address" text NOT NULL,
	"account_wallet_id" text NOT NULL,
	"account_owner_quorum_id" text NOT NULL,
	"state" text DEFAULT 'policy_prepared' NOT NULL,
	"issue" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approval_nonce" bigint,
	"consent_expires_at" timestamp with time zone,
	"consent_digest" text,
	"approval_attempted_at" timestamp with time zone,
	"authorization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_agent_setups_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "copy_agent_setups_policy_attempt_id_unique" UNIQUE("policy_attempt_id"),
	CONSTRAINT "copy_agent_setups_network_check" CHECK ("copy_agent_setups"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_agent_setups_state_check" CHECK ("copy_agent_setups"."state" in ('policy_prepared', 'policy_unknown', 'wallet_prepared', 'wallet_unknown', 'ready', 'approval_signing', 'approval_unknown', 'active', 'blocked', 'revoked')),
	CONSTRAINT "copy_agent_setups_bound_check" CHECK ("copy_agent_setups"."revision" >= 1 and "copy_agent_setups"."valid_for_days" between 1 and 30 and "copy_agent_setups"."expires_at" > "copy_agent_setups"."created_at" and "copy_agent_setups"."account_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "copy_agent_setups_ready_check" CHECK ("copy_agent_setups"."state" not in ('ready', 'approval_signing', 'approval_unknown', 'active') or ("copy_agent_setups"."agent_wallet_id" is not null and "copy_agent_setups"."agent_owner_quorum_id" is not null and "copy_agent_setups"."agent_address" ~ '^0x[0-9a-f]{40}$' and "copy_agent_setups"."policy_id" is not null and "copy_agent_setups"."policy_fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_agent_setups_attempt_check" CHECK ("copy_agent_setups"."approval_attempted_at" is null or ("copy_agent_setups"."approval_nonce" is not null and "copy_agent_setups"."consent_digest" is not null and "copy_agent_setups"."consent_expires_at" is not null))
);
--> statement-breakpoint
DROP INDEX "copy_execution_wallets_account_uq";--> statement-breakpoint
DROP INDEX "copy_execution_wallets_strategy_uq";--> statement-breakpoint
ALTER TABLE "copy_execution_wallets" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "copy_agent_setups" ADD CONSTRAINT "copy_agent_setups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_agent_setups" ADD CONSTRAINT "copy_agent_setups_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_agent_setups" ADD CONSTRAINT "copy_agent_setups_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_agent_setups_idempotency_uq" ON "copy_agent_setups" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_agent_setups_current_uq" ON "copy_agent_setups" USING btree ("network","account_id") WHERE "copy_agent_setups"."state" not in ('blocked', 'revoked');--> statement-breakpoint
CREATE UNIQUE INDEX "copy_agent_setups_agent_uq" ON "copy_agent_setups" USING btree ("agent_wallet_id");--> statement-breakpoint
CREATE INDEX "copy_agent_setups_owner_idx" ON "copy_agent_setups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_execution_wallets_account_uq" ON "copy_execution_wallets" USING btree ("network","account_address") WHERE "copy_execution_wallets"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_execution_wallets_strategy_uq" ON "copy_execution_wallets" USING btree ("network","strategy_id") WHERE "copy_execution_wallets"."retired_at" is null;