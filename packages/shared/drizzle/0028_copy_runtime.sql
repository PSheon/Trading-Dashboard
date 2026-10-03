CREATE TABLE "copy_equity_snapshots" (
	"strategy_id" integer NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"equity" numeric,
	"total_pnl" numeric,
	"net_deposits" numeric NOT NULL,
	"exposure_usd" numeric,
	CONSTRAINT "copy_equity_snapshots_strategy_id_time_pk" PRIMARY KEY("strategy_id","time")
);
--> statement-breakpoint
CREATE TABLE "copy_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_id" integer,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_operations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"mode" text NOT NULL,
	"network" text NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copy_ledger" DROP CONSTRAINT "copy_ledger_kind_check";--> statement-breakpoint
ALTER TABLE "copy_ledger" DROP CONSTRAINT "copy_ledger_sign_check";--> statement-breakpoint
ALTER TABLE "copy_strategies" DROP CONSTRAINT "copy_strategies_amounts_check";--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD COLUMN "withdrawn" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_equity_snapshots" ADD CONSTRAINT "copy_equity_snapshots_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_events" ADD CONSTRAINT "copy_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_events" ADD CONSTRAINT "copy_events_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_operations" ADD CONSTRAINT "copy_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_events_owner_cursor_idx" ON "copy_events" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_operations_key_uq" ON "copy_operations" USING btree ("user_id","mode","network","key");--> statement-breakpoint
ALTER TABLE "copy_ledger" ADD CONSTRAINT "copy_ledger_kind_check" CHECK ("copy_ledger"."kind" in ('allocate', 'realized_pnl', 'fee', 'builder_fee', 'funding', 'release', 'withdraw', 'liquidation'));--> statement-breakpoint
ALTER TABLE "copy_ledger" ADD CONSTRAINT "copy_ledger_sign_check" CHECK ("copy_ledger"."amount" <> 0 and case "copy_ledger"."kind" when 'allocate' then "copy_ledger"."amount" > 0 when 'liquidation' then "copy_ledger"."amount" > 0 when 'fee' then "copy_ledger"."amount" < 0 when 'builder_fee' then "copy_ledger"."amount" < 0 when 'release' then "copy_ledger"."amount" < 0 when 'withdraw' then "copy_ledger"."amount" < 0 else true end);--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_amounts_check" CHECK ("copy_strategies"."allocated" > 0 and "copy_strategies"."withdrawn" >= 0 and "copy_strategies"."fees" >= 0 and "copy_strategies"."version" >= 1 and "copy_strategies"."control_revision" >= 0);