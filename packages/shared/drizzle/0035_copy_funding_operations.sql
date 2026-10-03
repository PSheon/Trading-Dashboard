CREATE TABLE "copy_funding_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"destination" text NOT NULL,
	"amount" text NOT NULL,
	"nonce" bigint NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"evidence_hash" text,
	"transaction_hash" text,
	"credited_amount" text,
	"fee" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_funding_network_check" CHECK ("copy_funding_operations"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_funding_status_check" CHECK ("copy_funding_operations"."status" in ('prepared', 'unknown', 'accepted', 'credited', 'rejected', 'cancelled')),
	CONSTRAINT "copy_funding_identity_check" CHECK ("copy_funding_operations"."address" ~ '^0x[0-9a-f]{40}$' and "copy_funding_operations"."destination" ~ '^0x[0-9a-f]{40}$' and "copy_funding_operations"."address" <> "copy_funding_operations"."destination" and "copy_funding_operations"."nonce" > 0 and "copy_funding_operations"."nonce" <= 9007199254740991),
	CONSTRAINT "copy_funding_amount_check" CHECK ("copy_funding_operations"."amount" ~ '^[0-9]+(\.[0-9]{1,6})?$' and length("copy_funding_operations"."amount") <= 32 and "copy_funding_operations"."amount"::numeric > 0 and "copy_funding_operations"."amount"::numeric <= 1000000000000),
	CONSTRAINT "copy_funding_attempt_check" CHECK ("copy_funding_operations"."attempted_at" is null or "copy_funding_operations"."claimed_at" is not null),
	CONSTRAINT "copy_funding_outcome_check" CHECK ("copy_funding_operations"."status" not in ('accepted', 'credited', 'rejected') or ("copy_funding_operations"."evidence_hash" is not null and "copy_funding_operations"."evidence_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "copy_funding_credit_check" CHECK ("copy_funding_operations"."status" <> 'credited' or ("copy_funding_operations"."transaction_hash" is not null and "copy_funding_operations"."transaction_hash" ~ '^0x[0-9a-f]{64}$' and "copy_funding_operations"."credited_amount" is not null and "copy_funding_operations"."fee" is not null and "copy_funding_operations"."credited_amount" ~ '^[0-9]+(\.[0-9]{1,6})?$' and "copy_funding_operations"."fee" ~ '^[0-9]+(\.[0-9]{1,6})?$' and "copy_funding_operations"."credited_amount"::numeric > 0 and "copy_funding_operations"."fee"::numeric >= 0 and "copy_funding_operations"."credited_amount"::numeric + "copy_funding_operations"."fee"::numeric = "copy_funding_operations"."amount"::numeric))
);
--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_operations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_funding_key_uq" ON "copy_funding_operations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_funding_nonce_uq" ON "copy_funding_operations" USING btree ("network","address","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_funding_pending_uq" ON "copy_funding_operations" USING btree ("network","address") WHERE "copy_funding_operations"."status" in ('prepared', 'unknown', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "copy_funding_receipt_uq" ON "copy_funding_operations" USING btree ("network","transaction_hash");--> statement-breakpoint
CREATE INDEX "copy_funding_owner_idx" ON "copy_funding_operations" USING btree ("user_id","created_at");