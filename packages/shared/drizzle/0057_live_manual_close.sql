CREATE TABLE "copy_live_manual_closes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"coin" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"reason" text,
	"execution_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copy_live_manual_closes_check" CHECK ("copy_live_manual_closes"."state" in ('requested', 'done', 'refused') and length("copy_live_manual_closes"."coin") between 1 and 129 and jsonb_typeof("copy_live_manual_closes"."execution_keys") = 'array' and jsonb_array_length("copy_live_manual_closes"."execution_keys") <= 10 and ("copy_live_manual_closes"."state" <> 'refused' or "copy_live_manual_closes"."reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "copy_live_manual_closes" ADD CONSTRAINT "copy_live_manual_closes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_manual_closes" ADD CONSTRAINT "copy_live_manual_closes_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_live_manual_closes" ADD CONSTRAINT "copy_live_manual_closes_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_manual_closes_key_uq" ON "copy_live_manual_closes" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_live_manual_closes_open_uq" ON "copy_live_manual_closes" USING btree ("account_id","coin") WHERE "copy_live_manual_closes"."state" = 'requested';--> statement-breakpoint
CREATE INDEX "copy_live_manual_closes_account_idx" ON "copy_live_manual_closes" USING btree ("account_id","created_at");