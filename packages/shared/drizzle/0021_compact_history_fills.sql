CREATE TABLE "history_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "history_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_fills" (
	"tid" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"oid" bigint,
	"twap_id" bigint,
	"account_id" integer NOT NULL,
	"coin_id" integer,
	"dir_id" integer,
	"fee_token_id" integer,
	"twap" boolean NOT NULL,
	"side_buy" boolean,
	"crossed" boolean,
	"origin" text DEFAULT 'rest' NOT NULL,
	"hash" "bytea",
	"px" numeric,
	"sz" numeric,
	"start_position" numeric,
	"closed_pnl" numeric,
	"fee" numeric,
	"cloid" "bytea",
	"builder" "bytea",
	"builder_fee" numeric,
	"deployer_fee" numeric,
	"priority_gas" numeric,
	"liquidated_user" "bytea",
	"liquidation_mark_px" numeric,
	"liquidation_method" text,
	"extra" jsonb,
	CONSTRAINT "history_fills_account_id_twap_tid_pk" PRIMARY KEY("account_id","twap","tid")
);
--> statement-breakpoint
CREATE TABLE "history_terms" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "history_terms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"term" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_fills" ADD CONSTRAINT "history_fills_account_id_history_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."history_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_fills" ADD CONSTRAINT "history_fills_coin_id_history_terms_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."history_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_fills" ADD CONSTRAINT "history_fills_dir_id_history_terms_id_fk" FOREIGN KEY ("dir_id") REFERENCES "public"."history_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_fills" ADD CONSTRAINT "history_fills_fee_token_id_history_terms_id_fk" FOREIGN KEY ("fee_token_id") REFERENCES "public"."history_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "history_accounts_chain_address_idx" ON "history_accounts" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "history_fills_account_time_idx" ON "history_fills" USING btree ("account_id","time");--> statement-breakpoint
CREATE UNIQUE INDEX "history_terms_term_idx" ON "history_terms" USING btree ("term");