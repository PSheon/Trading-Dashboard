-- Leverage set by the worker's agent before a copy's open (updateLeverage, cross, at the copy's cap): a journal like an order's,
-- its nonce from the signer's shared allocator. Additive: a new table only.
CREATE TABLE "copy_live_leverage_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"network" text NOT NULL,
	"account_address" text NOT NULL,
	"signer_address" text NOT NULL,
	"authorization_id" text NOT NULL,
	"coin" text NOT NULL,
	"asset" integer NOT NULL,
	"from_leverage" integer NOT NULL,
	"leverage" integer NOT NULL,
	"nonce" bigint NOT NULL,
	"expires_after" bigint NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"issue" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_leverage_updates_check" CHECK ("copy_live_leverage_updates"."network" in ('testnet','mainnet') and "copy_live_leverage_updates"."state" in ('prepared', 'submitting', 'unknown', 'accepted', 'rejected') and "copy_live_leverage_updates"."account_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_leverage_updates"."signer_address" ~ '^0x[0-9a-f]{40}$' and "copy_live_leverage_updates"."asset" >= 0 and "copy_live_leverage_updates"."leverage" >= 1 and "copy_live_leverage_updates"."from_leverage" >= 1 and "copy_live_leverage_updates"."nonce" > 0 and "copy_live_leverage_updates"."expires_after" > "copy_live_leverage_updates"."nonce")
);
--> statement-breakpoint
ALTER TABLE "copy_live_leverage_updates" ADD CONSTRAINT "copy_live_leverage_updates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_leverage_updates" ADD CONSTRAINT "copy_live_leverage_updates_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_leverage_updates_nonce_uq" ON "copy_live_leverage_updates" USING btree ("network","signer_address","nonce");--> statement-breakpoint
CREATE INDEX "copy_live_leverage_updates_account_idx" ON "copy_live_leverage_updates" USING btree ("account_id","coin","created_at");