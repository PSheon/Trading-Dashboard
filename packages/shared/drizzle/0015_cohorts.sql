CREATE TABLE "cohort_members" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"rank" integer NOT NULL,
	"pnl_all" numeric,
	"roi_all" numeric,
	"perp_equity" numeric,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dexes" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone,
	"swept_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "cohort_members_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "cohort_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"tier" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"member_count" integer NOT NULL,
	"wallet_count" integer NOT NULL,
	"notional_long" numeric NOT NULL,
	"notional_short" numeric NOT NULL,
	"long_pct" numeric,
	"upnl_profit" numeric NOT NULL,
	"upnl_loss" numeric NOT NULL,
	"wallets_in_profit" integer NOT NULL,
	"wallets_in_loss" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cohort_members_tier_idx" ON "cohort_members" USING btree ("tier","rank");--> statement-breakpoint
CREATE INDEX "cohort_members_attempted_idx" ON "cohort_members" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "cohort_snapshots_tier_ts_idx" ON "cohort_snapshots" USING btree ("chain","tier","ts");