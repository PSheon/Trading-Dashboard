CREATE TABLE "fill_coverage" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"verified_from" timestamp with time zone,
	"verified_through" timestamp with time zone,
	"checked_through" timestamp with time zone,
	"backfill_status" text DEFAULT 'pending' NOT NULL,
	"backfill_floor" timestamp with time zone NOT NULL,
	"backfill_span_ms" bigint DEFAULT 21600000 NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revised_at" timestamp with time zone,
	"last_error" text,
	"failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fill_coverage_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE INDEX "fill_coverage_backfill_idx" ON "fill_coverage" USING btree ("backfill_status","updated_at");