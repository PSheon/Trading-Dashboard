CREATE TABLE "discovery_traders" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"pool_rank" integer,
	"in_pool" boolean DEFAULT true NOT NULL,
	"account_value" numeric,
	"pnl_all" numeric,
	"roi_all" numeric,
	"pnl_30d" numeric,
	"roi_30d" numeric,
	"sharpe" numeric,
	"max_drawdown" numeric,
	"return_samples" integer,
	"span_days" numeric,
	"copy_score" integer,
	"style" text,
	"top_coins" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_trade_at" timestamp with time zone,
	"coin_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trades_from" timestamp with time zone,
	"sparkline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sparkline_30d" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"portfolio_at" timestamp with time zone,
	"trades_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "discovery_traders_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "kol_traders" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"x_handle" text,
	"verified" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kol_traders_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE INDEX "discovery_traders_attempted_idx" ON "discovery_traders" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "discovery_traders_score_idx" ON "discovery_traders" USING btree ("copy_score" DESC NULLS LAST);