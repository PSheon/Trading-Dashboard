CREATE TABLE "copy_live_setup_aborts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"setup_id" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"account_id" text,
	"network" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"owner_privy_user_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"account_address" text,
	"destination" text NOT NULL,
	"intent_digest" text,
	"consent_digest" text,
	"funding_operation_id" text,
	"mandate_id" text,
	"stop_id" text,
	"return_operation_id" text,
	"state" text DEFAULT 'requested' NOT NULL,
	"issue" text,
	"proof_digest" text,
	"proof_read_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_live_setup_aborts_state_check" CHECK ("copy_live_setup_aborts"."state" in ('requested', 'draining', 'waiting_credit', 'proving', 'returning', 'delegated', 'done', 'blocked')),
	CONSTRAINT "copy_live_setup_aborts_binding_check" CHECK ("copy_live_setup_aborts"."network" in ('testnet','mainnet') and "copy_live_setup_aborts"."kind" in ('start','edit','renewal') and "copy_live_setup_aborts"."owner_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_setup_aborts"."destination" = "copy_live_setup_aborts"."owner_address" and ("copy_live_setup_aborts"."account_address" is null or ("copy_live_setup_aborts"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_setup_aborts"."account_address" <> "copy_live_setup_aborts"."owner_address")) and length("copy_live_setup_aborts"."owner_privy_user_id") > 0 and "copy_live_setup_aborts"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$' and "copy_live_setup_aborts"."revision" >= 1),
	CONSTRAINT "copy_live_setup_aborts_digest_check" CHECK (("copy_live_setup_aborts"."intent_digest" is null or "copy_live_setup_aborts"."intent_digest" ~ '^[0-9a-f]{64}$') and ("copy_live_setup_aborts"."consent_digest" is null or ("copy_live_setup_aborts"."consent_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setup_aborts"."intent_digest" is not null)) and ("copy_live_setup_aborts"."proof_digest" is null or ("copy_live_setup_aborts"."proof_digest" ~ '^[0-9a-f]{64}$' and "copy_live_setup_aborts"."proof_read_at" is not null))),
	CONSTRAINT "copy_live_setup_aborts_delegation_check" CHECK (("copy_live_setup_aborts"."stop_id" is null or ("copy_live_setup_aborts"."kind" = 'start' and "copy_live_setup_aborts"."mandate_id" is not null)) and ("copy_live_setup_aborts"."state" <> 'delegated' or "copy_live_setup_aborts"."stop_id" is not null) and ("copy_live_setup_aborts"."return_operation_id" is null or ("copy_live_setup_aborts"."kind" = 'start' and "copy_live_setup_aborts"."stop_id" is null and "copy_live_setup_aborts"."proof_digest" is not null)))
);
--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "setup_abort_id" text;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_setup_id_copy_live_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."copy_live_setups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_funding_operation_id_copy_funding_operations_id_fk" FOREIGN KEY ("funding_operation_id") REFERENCES "public"."copy_funding_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_mandate_id_copy_live_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."copy_live_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_stop_id_copy_live_stop_operations_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."copy_live_stop_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_setup_aborts" ADD CONSTRAINT "copy_live_setup_aborts_return_operation_id_copy_funding_operations_id_fk" FOREIGN KEY ("return_operation_id") REFERENCES "public"."copy_funding_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_setup_aborts_setup_uq" ON "copy_live_setup_aborts" USING btree ("setup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_setup_aborts_key_uq" ON "copy_live_setup_aborts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "copy_live_setup_aborts_open_idx" ON "copy_live_setup_aborts" USING btree ("state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_setup_abort_id_copy_live_setup_aborts_id_fk" FOREIGN KEY ("setup_abort_id") REFERENCES "public"."copy_live_setup_aborts"("id") ON DELETE restrict ON UPDATE no action;