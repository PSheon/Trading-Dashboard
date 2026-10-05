CREATE TABLE "copy_live_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"stage" text DEFAULT 'provisioning' NOT NULL,
	"signer_kind" text,
	"leader_address" text NOT NULL,
	"source_network" text NOT NULL,
	"budget_usd" text NOT NULL,
	"settings" jsonb NOT NULL,
	"intent" jsonb,
	"intent_digest" text,
	"consent_digest" text,
	"consent_expires_at" timestamp with time zone,
	"setup_deadline" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"funding_operation_id" text,
	"agent_setup_id" text,
	"mode_operation_id" text,
	"builder_approval_id" text,
	"mandate_id" text,
	"issue" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_live_setups_kind_check" CHECK ("copy_live_setups"."kind" in ('start', 'edit', 'renewal')),
	CONSTRAINT "copy_live_setups_stage_check" CHECK ("copy_live_setups"."stage" in ('provisioning', 'awaiting_consent', 'consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready', 'running', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "copy_live_setups_signer_check" CHECK ("copy_live_setups"."signer_kind" is null or "copy_live_setups"."signer_kind" in ('owner_session', 'worker_policy')),
	CONSTRAINT "copy_live_setups_identity_check" CHECK ("copy_live_setups"."leader_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_setups"."source_network" in ('testnet', 'mainnet') and "copy_live_setups"."budget_usd" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' and "copy_live_setups"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$' and "copy_live_setups"."revision" >= 1 and "copy_live_setups"."attempts" >= 0),
	CONSTRAINT "copy_live_setups_consent_check" CHECK ("copy_live_setups"."stage" in ('provisioning', 'awaiting_consent', 'failed', 'expired', 'cancelled') or ("copy_live_setups"."consent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setups"."intent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setups"."confirmed_at" is not null and "copy_live_setups"."signer_kind" is not null and "copy_live_setups"."setup_deadline" is not null))
);
--> statement-breakpoint
ALTER TABLE "copy_account_mode_operations" ADD COLUMN "live_setup_id" text;--> statement-breakpoint
ALTER TABLE "copy_agent_setups" ADD COLUMN "live_setup_id" text;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "live_setup_id" text;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "signer_kind" text;--> statement-breakpoint
ALTER TABLE "copy_live_builder_approvals" ADD COLUMN "live_setup_id" text;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD COLUMN "consent_kind" text DEFAULT 'mandate' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD COLUMN "live_setup_id" text;--> statement-breakpoint
ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setups" ADD CONSTRAINT "copy_live_setups_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_setups_key_uq" ON "copy_live_setups" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_setups_current_uq" ON "copy_live_setups" USING btree ("strategy_id") WHERE "copy_live_setups"."stage" not in ('running', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE INDEX "copy_live_setups_open_idx" ON "copy_live_setups" USING btree ("stage","next_attempt_at");--> statement-breakpoint
CREATE INDEX "copy_live_setups_owner_idx" ON "copy_live_setups" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "copy_account_mode_operations" ADD CONSTRAINT "copy_account_mode_operations_live_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("live_setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_agent_setups" ADD CONSTRAINT "copy_agent_setups_live_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("live_setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_live_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("live_setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_builder_approvals" ADD CONSTRAINT "copy_live_builder_approvals_live_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("live_setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_live_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("live_setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_signer_kind_check" CHECK ("copy_funding_operations"."signer_kind" is null or "copy_funding_operations"."signer_kind" in ('owner_session', 'worker_policy'));--> statement-breakpoint
ALTER TABLE "copy_live_mandates" ADD CONSTRAINT "copy_live_mandates_consent_kind_check" CHECK ("copy_live_mandates"."consent_kind" in ('mandate', 'setup') and ("copy_live_mandates"."consent_kind" = 'mandate') = ("copy_live_mandates"."live_setup_id" is null));--> statement-breakpoint
DROP INDEX "copy_agent_setups_current_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "copy_agent_setups_active_uq" ON "copy_agent_setups" USING btree ("network","account_id") WHERE "copy_agent_setups"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "copy_agent_setups_pending_uq" ON "copy_agent_setups" USING btree ("network","account_id") WHERE "copy_agent_setups"."state" not in ('blocked', 'revoked', 'active');