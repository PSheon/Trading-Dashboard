CREATE TABLE "copy_follower_account_state" (
	"account_id" text PRIMARY KEY NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_account_state_check" CHECK (("copy_follower_account_state"."quarantined" and "copy_follower_account_state"."reason" is not null) or (not "copy_follower_account_state"."quarantined" and "copy_follower_account_state"."reason" is null))
);
--> statement-breakpoint
CREATE TABLE "copy_follower_ledger" (
	"receipt_key" text NOT NULL,
	"component" text NOT NULL,
	"amount" numeric NOT NULL,
	"token" text DEFAULT 'USDC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_ledger_receipt_key_component_pk" PRIMARY KEY("receipt_key","component"),
	CONSTRAINT "copy_follower_ledger_component_check" CHECK ("copy_follower_ledger"."component" in ('realized_pnl', 'exchange_fee', 'builder_fee', 'funding')),
	CONSTRAINT "copy_follower_ledger_token_check" CHECK ("copy_follower_ledger"."token" = 'USDC')
);
--> statement-breakpoint
CREATE TABLE "copy_follower_receipt_conflicts" (
	"receipt_key" text NOT NULL,
	"seen_digest" text NOT NULL,
	"seen_record" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_receipt_conflicts_receipt_key_seen_digest_pk" PRIMARY KEY("receipt_key","seen_digest"),
	CONSTRAINT "copy_follower_receipt_conflicts_digest_check" CHECK ("copy_follower_receipt_conflicts"."seen_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "copy_follower_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"coin" text NOT NULL,
	"provider_time" timestamp with time zone NOT NULL,
	"digest" text NOT NULL,
	"record" jsonb NOT NULL,
	"execution_key" text,
	"attribution" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_receipts_network_check" CHECK ("copy_follower_receipts"."network" in ('testnet', 'mainnet')),
	CONSTRAINT "copy_follower_receipts_kind_check" CHECK ("copy_follower_receipts"."kind" in ('fill', 'funding')),
	CONSTRAINT "copy_follower_receipts_identity_check" CHECK ("copy_follower_receipts"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_follower_receipts"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "copy_follower_receipts_attribution_check" CHECK (("copy_follower_receipts"."attribution" = 'execution' and "copy_follower_receipts"."kind" = 'fill' and "copy_follower_receipts"."execution_key" is not null) or ("copy_follower_receipts"."attribution" = 'account' and "copy_follower_receipts"."execution_key" is null))
);
--> statement-breakpoint
ALTER TABLE "copy_follower_account_state" ADD CONSTRAINT "copy_follower_account_state_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_ledger" ADD CONSTRAINT "copy_follower_ledger_receipt_key_copy_follower_receipts_key_fk" FOREIGN KEY ("receipt_key") REFERENCES "public"."copy_follower_receipts"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_receipt_conflicts" ADD CONSTRAINT "copy_follower_receipt_conflicts_receipt_key_copy_follower_receipts_key_fk" FOREIGN KEY ("receipt_key") REFERENCES "public"."copy_follower_receipts"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_receipts" ADD CONSTRAINT "copy_follower_receipts_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_follower_receipts" ADD CONSTRAINT "copy_follower_receipts_execution_key_copy_live_executions_key_fk" FOREIGN KEY ("execution_key") REFERENCES "public"."copy_live_executions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_follower_receipts_account_time_idx" ON "copy_follower_receipts" USING btree ("account_id","provider_time");