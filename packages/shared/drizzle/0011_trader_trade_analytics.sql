CREATE TABLE "trader_analytics" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"coverage_from" timestamp with time zone,
	"truncated" boolean DEFAULT false NOT NULL,
	"fills_read" integer DEFAULT 0 NOT NULL,
	"fill_cursor" timestamp with time zone,
	"cursor_tids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"funding_from" timestamp with time zone,
	"funding_cursor" timestamp with time zone,
	"summary" jsonb NOT NULL,
	"classification" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trader_analytics_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "trader_trades" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"open_tid" bigint NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"entry_time" timestamp with time zone NOT NULL,
	"exit_time" timestamp with time zone,
	"position" numeric NOT NULL,
	"max_size" numeric NOT NULL,
	"max_notional" numeric NOT NULL,
	"entry_sz" numeric NOT NULL,
	"entry_ntl" numeric NOT NULL,
	"exit_sz" numeric NOT NULL,
	"exit_ntl" numeric NOT NULL,
	"realized_pnl" numeric NOT NULL,
	"fees" numeric NOT NULL,
	"funding" numeric,
	"net_pnl" numeric NOT NULL,
	"liquidated" boolean DEFAULT false NOT NULL,
	"twap" boolean DEFAULT false NOT NULL,
	"fills" integer NOT NULL,
	"last_fill_time" timestamp with time zone NOT NULL,
	CONSTRAINT "trader_trades_chain_address_open_tid_pk" PRIMARY KEY("chain","address","open_tid")
);
--> statement-breakpoint
CREATE INDEX "trader_trades_address_entry_idx" ON "trader_trades" USING btree ("address","entry_time" DESC NULLS LAST,"open_tid" DESC NULLS LAST);